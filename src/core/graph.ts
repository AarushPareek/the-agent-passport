import {parseAgentScript} from './agent-script.ts'
import {parseBot, parseBotVersion, parseFunction, parsePlannerBundle, parsePlugin, parsePromptTemplate} from './classic.ts'
import type {AgentGraph, ComponentType, EdgeKind, GraphNode, Location, NodeStatus, NodeType} from './model.ts'
import {nodeId} from './model.ts'
import {findComponent, listComponents, readProjectFile} from './project.ts'
import type {ProjectIndex} from './project.ts'

/**
 * Platform-provided components carry a namespace prefix (`SvcCopilotTmpl__VerifyCustomer`, `EmployeeCopilot__QueryRecords`).
 * Custom suffixes (`__c`, `__mdt`, ...) are not namespaces.
 */
export function isNamespaced(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*__[A-Za-z0-9_]+$/.test(name) && !/__(c|mdt|e|x|b|r|share|history|feed)$/i.test(name)
}

/** Agent Script `target:` schemes and classic `invocationTargetType` values, mapped to the metadata type they point at. */
export function targetType(scheme: string): ComponentType | undefined {
  switch (scheme.toLowerCase()) {
    case 'apex':
      return 'ApexClass'
    case 'flow':
      return 'Flow'
    case 'generatepromptresponse':
    case 'prompt':
      return 'GenAiPromptTemplate'
    default:
      return undefined
  }
}

/** Collects nodes and edges for one agent, de-duplicated, in a stable order. */
class GraphBuilder {
  private readonly edges = new Map<string, {from: string; kind: EdgeKind; to: string}>()
  private readonly nodes = new Map<string, GraphNode>()
  private readonly project: ProjectIndex

  constructor(project: ProjectIndex) {
    this.project = project
  }

  /** Add a project component. Its status comes from the project index unless it is platform-provided. */
  component(type: ComponentType, name: string): GraphNode {
    const hit = findComponent(this.project, type, name)
    const status: NodeStatus = hit ? 'present' : isNamespaced(name) ? 'standard' : 'missing'
    return this.node(type, hit?.name ?? name, status, hit?.locations ?? [])
  }

  edge(from: GraphNode, kind: EdgeKind, to: GraphNode): void {
    this.edges.set(`${from.id}|${kind}|${to.id}`, {from: from.id, kind, to: to.id})
  }

  node(type: NodeType, name: string, status: NodeStatus, locations: Location[] = [], detail?: Record<string, string>): GraphNode {
    const id = nodeId(type, name)
    const existing = this.nodes.get(id)
    if (existing) return existing
    const created: GraphNode = {id, locations, name, status, type}
    if (detail) created.detail = detail
    this.nodes.set(id, created)
    return created
  }

  result(): Pick<AgentGraph, 'edges' | 'nodes'> {
    return {
      edges: [...this.edges.values()].sort((a, b) => `${a.from}|${a.kind}|${a.to}`.localeCompare(`${b.from}|${b.kind}|${b.to}`)),
      nodes: [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    }
  }
}

function buildAgentScriptGraph(project: ProjectIndex, bundleName: string, source: Location): AgentGraph {
  const script = parseAgentScript(readProjectFile(project, source))
  const agentName = script.developerName ?? bundleName
  const g = new GraphBuilder(project)
  const agent = g.node('Agent', agentName, 'present', [source], {bundle: bundleName})
  const bundle = g.component('AiAuthoringBundle', bundleName)
  g.edge(agent, 'defined-by', bundle)

  const blockNames = new Set(script.blocks.map((b) => b.name))
  for (const block of script.blocks) {
    const sub = g.node('Subagent', `${agentName}.${block.name}`, 'present', [source], {kind: block.kind})
    g.edge(agent, 'has-subagent', sub)
    for (const to of block.transitions) {
      const target = g.node('Subagent', `${agentName}.${to}`, blockNames.has(to) ? 'present' : 'missing', blockNames.has(to) ? [source] : [])
      g.edge(sub, 'transitions-to', target)
    }
    for (const action of block.actions) {
      const detail: Record<string, string> = {}
      if (action.target) detail.target = action.target.raw
      const node = g.node('AgentAction', `${agentName}.${block.name}.${action.name}`, 'present', [source], detail)
      g.edge(sub, 'defines-action', node)
      if (!action.target) continue
      const type = targetType(action.target.scheme)
      const dep = type ? g.component(type, action.target.name) : g.node('Unknown', action.target.raw, 'external')
      g.edge(node, 'invokes', dep)
    }
  }

  if (script.defaultAgentUser) g.edge(agent, 'runs-as', g.node('AgentUser', script.defaultAgentUser, 'external'))

  return {
    agent: agentName,
    agentType: script.agentType,
    agentUser: script.defaultAgentUser,
    label: script.agentLabel,
    model: 'agent-script',
    source,
    ...g.result(),
  }
}

function buildClassicGraph(project: ProjectIndex, botName: string, source: Location): AgentGraph {
  const bot = parseBot(readProjectFile(project, source))
  const g = new GraphBuilder(project)
  const agent = g.node('Agent', botName, 'present', [source])
  const botNode = g.component('Bot', botName)
  g.edge(agent, 'defined-by', botNode)

  const expandFunction = (from: GraphNode, name: string) => {
    const fn = g.component('GenAiFunction', name)
    g.edge(from, 'has-action', fn)
    if (fn.status !== 'present') return
    const {target, targetType: kind} = parseFunction(readProjectFile(project, fn.locations[0]))
    if (!target || !kind) return
    const type = targetType(kind)
    const dep = type ? g.component(type, target) : g.node('Unknown', `${kind}://${target}`, 'external')
    g.edge(fn, 'invokes', dep)
    if (type === 'GenAiPromptTemplate' && dep.status === 'present') {
      for (const ref of parsePromptTemplate(readProjectFile(project, dep.locations[0])).references) {
        const refType = ref.scheme.toUpperCase() === 'SOBJECT' ? (ref.name.endsWith('__c') ? 'CustomObject' : undefined) : targetType(ref.scheme)
        if (refType) g.edge(dep, 'uses-data', g.component(refType, ref.name))
      }
    }
  }

  const versions = listComponents(project, 'BotVersion').filter((v) => v.name.startsWith(`${botName}.`))
  for (const version of versions) {
    const versionNode = g.component('BotVersion', version.name)
    g.edge(botNode, 'has-version', versionNode)
    for (const plannerName of parseBotVersion(readProjectFile(project, version.locations[0])).planners) {
      const planner = g.component('GenAiPlannerBundle', plannerName)
      g.edge(versionNode, 'uses-planner', planner)
      if (planner.status !== 'present') continue
      const uses = parsePlannerBundle(readProjectFile(project, planner.locations[0]))
      for (const pluginName of uses.plugins) {
        const plugin = g.component('GenAiPlugin', pluginName)
        g.edge(planner, 'has-topic', plugin)
        if (plugin.status !== 'present') continue
        for (const fn of parsePlugin(readProjectFile(project, plugin.locations[0])).functions) expandFunction(plugin, fn)
      }
      for (const fn of uses.functions) expandFunction(planner, fn)
    }
  }

  if (bot.botUser) g.edge(agent, 'runs-as', g.node('AgentUser', bot.botUser, 'external'))

  return {
    agent: botName,
    agentType: bot.agentType ?? bot.type,
    agentUser: bot.botUser,
    label: bot.label,
    model: 'classic',
    source,
    ...g.result(),
  }
}

/** One graph per agent found in the project: every AiAuthoringBundle, then every Bot. */
export function buildAgentGraphs(project: ProjectIndex): AgentGraph[] {
  const graphs: AgentGraph[] = []
  for (const bundle of listComponents(project, 'AiAuthoringBundle')) {
    for (const location of bundle.locations) graphs.push(buildAgentScriptGraph(project, bundle.name, location))
  }
  for (const bot of listComponents(project, 'Bot')) {
    graphs.push(buildClassicGraph(project, bot.name, bot.locations[0]))
  }
  return graphs
}
