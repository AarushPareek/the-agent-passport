/**
 * Data model for the Agent Passport dependency graph (`passport/graph.json`).
 * Every agent gets its own graph: nodes are the pieces it needs, edges say why it needs them.
 */

/** Salesforce metadata types the scanner indexes in a project. */
export type ComponentType =
  | 'AiAuthoringBundle'
  | 'ApexClass'
  | 'Bot'
  | 'BotVersion'
  | 'CustomObject'
  | 'Flow'
  | 'GenAiFunction'
  | 'GenAiPlannerBundle'
  | 'GenAiPlugin'
  | 'GenAiPromptTemplate'

/** Graph-only node types: parts of an agent that are not standalone metadata, plus the agent user. */
export type NodeType = 'Agent' | 'AgentAction' | 'AgentUser' | 'Subagent' | 'Unknown' | ComponentType

/**
 * - present: found in this project
 * - missing: referenced but not found in this project (it may already exist in the target org; `travel` checks that)
 * - standard: provided by the Salesforce platform (namespaced, for example `SvcCopilotTmpl__VerifyCustomer`)
 * - external: not deployable metadata at all (the agent user is a Salesforce user record)
 */
export type NodeStatus = 'external' | 'missing' | 'present' | 'standard'

/** A file location, relative to the project root, always with forward slashes. */
export type Location = {packageDir: string; path: string}

export type GraphNode = {
  detail?: Record<string, string>
  id: string
  locations: Location[]
  name: string
  status: NodeStatus
  type: NodeType
}

export type EdgeKind =
  | 'defined-by'
  | 'defines-action'
  | 'has-action'
  | 'has-subagent'
  | 'has-topic'
  | 'has-version'
  | 'invokes'
  | 'runs-as'
  | 'transitions-to'
  | 'uses-data'
  | 'uses-planner'

export type GraphEdge = {from: string; kind: EdgeKind; to: string}

/** `agent-script`: AiAuthoringBundle `.agent` file. `classic`: Bot, BotVersion, GenAiPlannerBundle, GenAiPlugin, GenAiFunction. */
export type AgentModel = 'agent-script' | 'classic'

export type AgentGraph = {
  agent: string
  agentType?: string
  agentUser?: string
  edges: GraphEdge[]
  label?: string
  model: AgentModel
  nodes: GraphNode[]
  source: Location
}

export type Severity = 'error' | 'info' | 'warn'

export type FindingCode =
  | 'AGENT_USER_HARDCODED'
  | 'AGENT_USER_MISSING'
  | 'AGENT_USER_PLACEHOLDER'
  | 'AGENT_USER_PLACEHOLDER_UNRESOLVED'
  | 'BUNDLE_OUTSIDE_DEFAULT_PACKAGE'
  | 'DUPLICATE_COMPONENT'
  | 'MISSING_DEPENDENCY'
  | 'NAME_MISMATCH'
  | 'REQUIREMENT_AGENT_USER'
  | 'REQUIREMENT_PUBLISH_ACTIVATE'
  | 'TRAVEL_GAP'
  | 'TRAVEL_UNCOMMITTED_EDITS'
  | 'UNKNOWN_TARGET'

export type Finding = {
  agent: string
  code: FindingCode
  component?: string
  fix: string
  locations?: Location[]
  message: string
  severity: Severity
}

export type PackageDirectory = {default: boolean; path: string}

export type ScanSummary = {
  agents: number
  errors: number
  infos: number
  missing: number
  standard: number
  warnings: number
}

export type ScanResult = {
  agents: AgentGraph[]
  findings: Finding[]
  project: {defaultPackageDir: string; packageDirectories: PackageDirectory[]}
  schemaVersion: 1
  summary: ScanSummary
  tool: string
}

export const nodeId = (type: NodeType, name: string): string => `${type}:${name}`
