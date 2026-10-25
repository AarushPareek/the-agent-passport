import type {AgentGraph, Finding, Severity} from './model.ts'
import {replacementCovers} from './project.ts'
import type {ProjectIndex} from './project.ts'

/** Agent types that run as a dedicated agent user rather than as the signed-in user. */
const SERVICE_AGENT_TYPES = new Set(['AgentforceServiceAgent', 'EinsteinServiceAgent', 'ExternalCopilot'])

/** `__AGENT_USER_PLACEHOLDER__`, `%%SF_CC_PLACEHOLDER_USERNAME%%`, and similar tokens meant to be replaced at deploy time. */
const PLACEHOLDER = /(__[A-Z0-9_]+__|%%[A-Z0-9_]+%%|\$\{[A-Za-z0-9_]+\})/

const SEVERITY_ORDER: Record<Severity, number> = {error: 0, info: 2, warn: 1}

function agentUserFindings(project: ProjectIndex, graph: AgentGraph): Finding[] {
  const user = graph.agentUser?.trim()
  const isService = graph.agentType !== undefined && SERVICE_AGENT_TYPES.has(graph.agentType)
  if (!user) {
    if (!isService) return []
    return [
      {
        agent: graph.agent,
        code: 'AGENT_USER_MISSING',
        fix: 'Set the agent user (Agent Script: `access: default_agent_user`; classic: `<botUser>` on the Bot), or create one with `sf org create agent-user`.',
        locations: [graph.source],
        message: `${graph.agentType} agents run as a dedicated agent user, but none is set.`,
        severity: 'warn',
      },
    ]
  }
  const token = user.match(PLACEHOLDER)?.[1]
  if (token) {
    const covered = replacementCovers(project, graph.source.path, token)
    return [
      covered
        ? {
            agent: graph.agent,
            code: 'AGENT_USER_PLACEHOLDER',
            fix: 'Make sure the environment variable used by the replacement is set for every environment you deploy to.',
            locations: [graph.source],
            message: `Agent user "${user}" is a placeholder that sfdx-project.json "replacements" rewrites at deploy time.`,
            severity: 'info',
          }
        : {
            agent: graph.agent,
            code: 'AGENT_USER_PLACEHOLDER_UNRESOLVED',
            fix: `Add a "replacements" entry to sfdx-project.json for ${graph.source.path} that replaces "${token}" with each environment's agent username (for example from an environment variable), or set the user per environment before deploying.`,
            locations: [graph.source],
            message: `Agent user "${user}" is a placeholder, and nothing in sfdx-project.json replaces it. Deployed as-is, the agent has no valid user.`,
            severity: 'warn',
          },
    ]
  }
  if (user.includes('@')) {
    return [
      {
        agent: graph.agent,
        code: 'AGENT_USER_HARDCODED',
        fix: 'Replace the username with a placeholder and an sfdx-project.json "replacements" entry, so each environment gets its own agent user.',
        locations: [graph.source],
        message: `Agent user "${user}" is a username from one specific org. Usernames are unique per org, so it will not exist in other environments.`,
        severity: 'warn',
      },
    ]
  }
  return []
}

export function computeFindings(project: ProjectIndex, graphs: AgentGraph[]): Finding[] {
  const findings: Finding[] = []
  for (const graph of graphs) {
    if (graph.model === 'agent-script') {
      const bundle = graph.nodes.find((n) => n.type === 'AiAuthoringBundle')
      if (bundle && graph.agent !== bundle.name) {
        findings.push({
          agent: graph.agent,
          code: 'NAME_MISMATCH',
          component: bundle.id,
          fix: `Make developer_name match the bundle folder: set developer_name: "${bundle.name}" (or rename the folder and files to ${graph.agent}).`,
          locations: [graph.source],
          message: `developer_name "${graph.agent}" does not match the bundle folder "${bundle.name}". \`sf agent publish authoring-bundle\` looks the bundle up by developer_name and fails.`,
          severity: 'error',
        })
      }
      if (graph.source.packageDir !== project.defaultPackageDir) {
        findings.push({
          agent: graph.agent,
          code: 'BUNDLE_OUTSIDE_DEFAULT_PACKAGE',
          fix: `Move the bundle into "${project.defaultPackageDir}", or mark "${graph.source.packageDir}" as default in sfdx-project.json before publishing.`,
          locations: [graph.source],
          message: `The bundle is in "${graph.source.packageDir}", but the default package directory is "${project.defaultPackageDir}". \`sf agent publish authoring-bundle\` only searched the default directory in our tests (Salesforce CLI 2.145.6).`,
          severity: 'warn',
        })
      }
    }

    for (const node of graph.nodes) {
      if (node.status === 'missing' && node.type === 'Subagent') {
        findings.push({
          agent: graph.agent,
          code: 'MISSING_DEPENDENCY',
          component: node.id,
          fix: 'Define the subagent in the .agent file or fix the transition. `sf agent validate authoring-bundle` reports this too.',
          locations: [graph.source],
          message: `The script routes to subagent "${node.name.slice(graph.agent.length + 1)}", which is not defined in it.`,
          severity: 'error',
        })
      } else if (node.status === 'missing') {
        const users = graph.edges.filter((e) => e.to === node.id).map((e) => e.from)
        findings.push({
          agent: graph.agent,
          code: 'MISSING_DEPENDENCY',
          component: node.id,
          fix: `Add ${node.type} "${node.name}" to the project, or confirm it already exists in the target environment (\`agentia passport travel\` checks this).`,
          message: `${node.type} "${node.name}" is used by ${users.join(', ')} but is not in this project.`,
          severity: 'error',
        })
      } else if (node.status === 'present' && node.type !== 'Agent' && node.type !== 'Subagent' && node.type !== 'AgentAction' && node.locations.length > 1) {
        const dirs = [...new Set(node.locations.map((l) => l.packageDir))]
        findings.push({
          agent: graph.agent,
          code: 'DUPLICATE_COMPONENT',
          component: node.id,
          fix: 'Keep one copy. Which copy reaches the org depends on deploy order, so the agent may run a different version than you tested.',
          locations: node.locations,
          message: `${node.type} "${node.name}" is defined ${node.locations.length} times${dirs.length > 1 ? ` across ${dirs.join(' and ')}` : ''}.`,
          severity: 'warn',
        })
      } else if (node.type === 'Unknown') {
        findings.push({
          agent: graph.agent,
          code: 'UNKNOWN_TARGET',
          component: node.id,
          fix: 'Check this target manually; Agent Passport does not know this target type yet.',
          message: `Target "${node.name}" has a type Agent Passport does not recognise, so its dependencies were not checked.`,
          severity: 'info',
        })
      }
    }

    findings.push(...agentUserFindings(project, graph))
  }
  return findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.agent.localeCompare(b.agent) || a.code.localeCompare(b.code) || (a.component ?? '').localeCompare(b.component ?? ''),
  )
}
