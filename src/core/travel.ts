import {mkdirSync, writeFileSync} from 'node:fs'
import {dirname, isAbsolute, join} from 'node:path'

import type {PluginPipeline} from '@copado/agentia-plugin-sdk'

import {committedChanges, currentBranch, GitError, isRepository, listFiles, resolveBranch, uncommittedFiles} from './git.ts'
import type {AgentGraph, ComponentType, Finding, Severity} from './model.ts'
import {classifyPath, componentKey, ownerComponent, ProjectError} from './project.ts'
import {runScan, TOOL} from './scan.ts'

/**
 * Travel check: if the current story is promoted to the target environment, will everything the agent needs arrive?
 * Copado promotes a story's committed changes onto the target environment's branch. So a dependency arrives when it is
 * in the story's committed changes, or is already on the target branch. Anything else is a gap.
 */

export type TravelStatus = 'gap' | 'in-story' | 'on-target' | 'platform'

/**
 * - missing: not in the project at all, and not on the target branch
 * - uncommitted: only exists as an uncommitted local file, so the promotion cannot carry it
 * - not-in-story: exists on this branch, but the story did not change it and the target branch does not have it
 * - deleted-in-story: the story deletes it, but the agent still needs it
 */
export type GapReason = 'deleted-in-story' | 'missing' | 'not-in-story' | 'uncommitted'

export type TravelItem = {
  component: string
  name: string
  /** Graph node ids that depend on this component. */
  neededBy: string[]
  reason?: GapReason
  status: TravelStatus
  type: ComponentType
  /** Set when the story's version differs locally (uncommitted edits) and only the committed or target version travels. */
  uncommittedEdits?: boolean
}

/** A Copado user story deployment step that would cover a requirement metadata cannot. */
export type ProposedStep = {
  instructions: string
  name: string
  /** Run before or after the metadata deployment in the target environment. */
  order: 'after' | 'before'
  type: 'Manual Task'
}

export type Requirement = {
  code: 'REQUIREMENT_AGENT_USER' | 'REQUIREMENT_PUBLISH_ACTIVATE'
  fix: string
  message: string
  proposedStep: ProposedStep
  severity: Severity
}

export type AgentTravel = {
  agent: string
  items: TravelItem[]
  model: AgentGraph['model']
  ok: boolean
  requirements: Requirement[]
}

export type TravelTarget = {
  branch: string
  /** Copado environment name, when the branch was resolved from the pipeline. */
  environment?: string
  /** The Git ref that was compared, e.g. `origin/main`. */
  ref: string
  resolvedFrom: 'branch-flag' | 'pipeline'
}

export type TravelResult = {
  agents: AgentTravel[]
  findings: Finding[]
  ok: boolean
  schemaVersion: 1
  story: {branch?: string; committedFiles: number; uncommittedFiles: number}
  summary: {gaps: number; inStory: number; onTarget: number; platform: number; requirements: number}
  target: TravelTarget
  tool: string
}

/** Graph node types that are deployable metadata and therefore have to travel. */
const METADATA_TYPES = new Set<string>(['AiAuthoringBundle', 'ApexClass', 'Bot', 'BotVersion', 'CustomObject', 'Flow', 'GenAiFunction', 'GenAiPlannerBundle', 'GenAiPlugin', 'GenAiPromptTemplate'])

/**
 * Which Git branch belongs to a Copado environment in a pipeline. An environment works on the branch of the connection
 * that leaves it; the last environment (no outgoing connection) works on the pipeline's main branch.
 */
export function branchForEnvironment(pipeline: PluginPipeline, environment: string): string | undefined {
  const wanted = environment.toLowerCase()
  const matches = (ref?: {id?: string; name?: string}) => ref !== undefined && (ref.name?.toLowerCase() === wanted || ref.id?.toLowerCase() === wanted)
  const connections = pipeline.connections ?? []
  const outgoing = connections.find((c) => matches(c.sourceEnvironment))
  if (outgoing?.branch) return outgoing.branch
  if (!outgoing && connections.some((c) => matches(c.destinationEnvironment))) return pipeline.mainBranch
  return undefined
}

/** Environment names in a pipeline, for error messages. */
export function environmentNames(pipeline: PluginPipeline): string[] {
  const names = new Set<string>()
  for (const c of pipeline.connections ?? []) {
    if (c.sourceEnvironment?.name) names.add(c.sourceEnvironment.name)
    if (c.destinationEnvironment?.name) names.add(c.destinationEnvironment.name)
  }
  return [...names]
}

function keysOf(paths: string[], owner: boolean): Set<string> {
  const keys = new Set<string>()
  for (const path of paths) {
    const hit = owner ? ownerComponent(path) : classifyPath(path)
    if (hit) keys.add(componentKey(hit.type, hit.name))
  }
  return keys
}

function requirementsFor(graph: AgentGraph, scanCodes: Set<string>, hasPlannerBundle: boolean, targetLabel: string): Requirement[] {
  const requirements: Requirement[] = []
  const bundle = graph.nodes.find((n) => n.type === 'AiAuthoringBundle')?.name ?? graph.agent
  if (graph.agentUser !== undefined || scanCodes.has('AGENT_USER_MISSING')) {
    const blocked = ['AGENT_USER_HARDCODED', 'AGENT_USER_MISSING', 'AGENT_USER_PLACEHOLDER_UNRESOLVED'].some((c) => scanCodes.has(c))
    requirements.push({
      code: 'REQUIREMENT_AGENT_USER',
      fix: blocked
        ? 'Fix the agent user first (see the scan finding), then make sure the user exists in the target org.'
        : 'Make sure the agent user exists in the target org and has the permission sets the agent\'s actions need.',
      message: `${graph.agent} runs as an agent user, which is a Salesforce user record, not metadata. It does not travel with the story and must already exist in ${targetLabel}.${blocked ? ' The agent file does not name a user that will exist there.' : ''}`,
      proposedStep: {
        instructions: [
          `Before deploying, in the ${targetLabel} org:`,
          `1. Create the agent user if it does not exist: sf org create agent-user --target-org <${targetLabel} alias>`,
          '2. Assign the permission sets the agent\'s actions need to that user (sf org assign permset --on-behalf-of <agent username>).',
          '3. Make sure the agent file or sfdx-project.json "replacements" give this environment\'s agent username.',
        ].join('\n'),
        name: `Agent user for ${graph.agent} exists in ${targetLabel}`,
        order: 'before',
        type: 'Manual Task',
      },
      severity: blocked ? 'warn' : 'info',
    })
  }
  if (graph.model === 'agent-script' && !hasPlannerBundle) {
    requirements.push({
      code: 'REQUIREMENT_PUBLISH_ACTIVATE',
      fix: `Add a post-deployment step to the user story that publishes and activates the agent, or keep the agent's GenAiPlannerBundle in source control so deployment publishes it.`,
      message: `Deploying the authoring bundle does not make ${graph.agent} live. Without its GenAiPlannerBundle in source control, the agent must be published and activated in ${targetLabel} after every deployment.`,
      proposedStep: {
        instructions: [
          `After deploying, in the ${targetLabel} org:`,
          `sf agent publish authoring-bundle --api-name ${bundle} --target-org <${targetLabel} alias>`,
          `sf agent activate --api-name ${bundle} --target-org <${targetLabel} alias>`,
        ].join('\n'),
        name: `Publish and activate ${graph.agent} in ${targetLabel}`,
        order: 'after',
        type: 'Manual Task',
      },
      severity: 'warn',
    })
  }
  return requirements
}

const GAP_TEXT: Record<GapReason, string> = {
  'deleted-in-story': 'the story deletes it, but the agent still needs it',
  missing: 'it is not in the project and not on the target branch',
  'not-in-story': 'it exists on this branch, but the story does not change it and the target branch does not have it, so the promotion will not carry it',
  uncommitted: 'it only exists as an uncommitted local file; commit it to the story so the promotion carries it',
}

export type TravelOptions = {
  agent?: string
  fetch?: boolean
  /** Git branch of the target environment. */
  targetBranch: string
  /** Copado environment name, if the branch came from the pipeline. */
  targetEnvironment?: string
}

export function runTravel(projectRoot: string, options: TravelOptions): TravelResult {
  if (!isRepository(projectRoot)) throw new ProjectError(`${projectRoot} is not inside a Git repository. Travel compares your story branch with the target branch.`)
  const scan = runScan(projectRoot, {agent: options.agent})
  let ref: string
  try {
    ref = resolveBranch(projectRoot, options.targetBranch, {fetch: options.fetch})
  } catch (error) {
    if (error instanceof GitError) throw new ProjectError(error.message)
    throw error
  }
  const label = options.targetEnvironment ?? options.targetBranch
  const committed = committedChanges(projectRoot, ref)
  const uncommitted = uncommittedFiles(projectRoot)
  const storyKeys = keysOf(committed.changed, true)
  const deletedKeys = keysOf(committed.deleted, false)
  const uncommittedKeys = keysOf(uncommitted, true)
  const targetKeys = keysOf(listFiles(projectRoot, ref), false)

  const findings: Finding[] = []
  const agents: AgentTravel[] = []
  for (const graph of scan.agents) {
    const items: TravelItem[] = []
    for (const node of graph.nodes) {
      if (!METADATA_TYPES.has(node.type)) continue
      const type = node.type as ComponentType
      const key = componentKey(type, node.name)
      const neededBy = graph.edges.filter((e) => e.to === node.id).map((e) => e.from)
      const item: TravelItem = {component: node.id, name: node.name, neededBy, status: 'gap', type}
      if (node.status === 'standard') item.status = 'platform'
      else if (storyKeys.has(key)) item.status = 'in-story'
      else if (deletedKeys.has(key) && node.status !== 'present') item.reason = 'deleted-in-story'
      else if (targetKeys.has(key)) item.status = 'on-target'
      else if (node.status === 'missing') item.reason = 'missing'
      else if (uncommittedKeys.has(key)) item.reason = 'uncommitted'
      else item.reason = 'not-in-story'
      if (item.status !== 'platform' && node.status === 'present' && uncommittedKeys.has(key) && item.reason !== 'uncommitted') item.uncommittedEdits = true
      items.push(item)

      if (item.status === 'gap' && item.reason) {
        findings.push({
          agent: graph.agent,
          code: 'TRAVEL_GAP',
          component: node.id,
          fix: item.reason === 'missing' ? `Add ${type} "${node.name}" to the story.` : item.reason === 'uncommitted' ? `Commit ${type} "${node.name}" to the story.` : `Include ${type} "${node.name}" in the story's commit so it is promoted with the agent.`,
          locations: node.locations,
          message: `${type} "${node.name}" will not arrive in ${label}: ${GAP_TEXT[item.reason]}.`,
          severity: 'error',
        })
      } else if (item.uncommittedEdits) {
        findings.push({
          agent: graph.agent,
          code: 'TRAVEL_UNCOMMITTED_EDITS',
          component: node.id,
          fix: 'Commit the edits to the story, or discard them, so what you tested is what gets promoted.',
          locations: node.locations,
          message: `${type} "${node.name}" has uncommitted local edits that will not travel. ${label} will get ${item.status === 'in-story' ? 'the version committed to the story' : `the version already on ${options.targetBranch}`}, not what is on your machine.`,
          severity: 'warn',
        })
      }
    }
    items.sort((a, b) => a.component.localeCompare(b.component))

    const scanCodes = new Set(scan.findings.filter((f) => f.agent === graph.agent).map((f) => f.code))
    const bundleName = graph.nodes.find((n) => n.type === 'AiAuthoringBundle')?.name
    const hasPlanner = [graph.agent, bundleName].some((n) => n !== undefined && (storyKeys.has(componentKey('GenAiPlannerBundle', n)) || targetKeys.has(componentKey('GenAiPlannerBundle', n))))
    const requirements = requirementsFor(graph, scanCodes, hasPlanner, label)
    for (const r of requirements) findings.push({agent: graph.agent, code: r.code, fix: r.fix, message: r.message, severity: r.severity})

    agents.push({agent: graph.agent, items, model: graph.model, ok: !items.some((i) => i.status === 'gap'), requirements})
  }

  const all = agents.flatMap((a) => a.items)
  const order: Record<Severity, number> = {error: 0, info: 2, warn: 1}
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.agent.localeCompare(b.agent) || a.code.localeCompare(b.code) || (a.component ?? '').localeCompare(b.component ?? ''))
  return {
    agents,
    findings,
    ok: agents.every((a) => a.ok),
    schemaVersion: 1,
    story: {branch: currentBranch(projectRoot), committedFiles: committed.changed.length + committed.deleted.length, uncommittedFiles: uncommitted.length},
    summary: {
      gaps: all.filter((i) => i.status === 'gap').length,
      inStory: all.filter((i) => i.status === 'in-story').length,
      onTarget: all.filter((i) => i.status === 'on-target').length,
      platform: all.filter((i) => i.status === 'platform').length,
      requirements: agents.reduce((n, a) => n + a.requirements.length, 0),
    },
    target: {branch: options.targetBranch, environment: options.targetEnvironment, ref, resolvedFrom: options.targetEnvironment ? 'pipeline' : 'branch-flag'},
    tool: TOOL,
  }
}

export const travelFileName = (label: string): string => join('passport', `travel-${label.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`)

export function writeTravelResult(result: TravelResult, projectRoot: string, outPath?: string): string {
  const relative = outPath ?? travelFileName(result.target.environment ?? result.target.branch)
  const target = isAbsolute(relative) ? relative : join(projectRoot, relative)
  mkdirSync(dirname(target), {recursive: true})
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return target
}
