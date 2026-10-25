import type {AgentiaPluginHost, PluginWorkItem} from '@copado/agentia-plugin-sdk'

/** The slice of the Agentia host API that `passport hello` uses. Tests pass a fake with the same shape. */
export type HelloHost = Pick<AgentiaPluginHost, 'auth' | 'cliVersion' | 'work' | 'workspace'>

export type AuthRow = {configured: string; ready: string; service: string; source: string}

export type AcceptanceCriteriaProbe = {
  /** Number of non-empty lines, a rough count of individual criteria. */
  lineCount: number
  length: number
  present: boolean
  text?: string
}

export type WorkItemProbe =
  | {acceptanceCriteria: AcceptanceCriteriaProbe; found: true; id: string; name?: string; status?: string; title?: string}
  | {error: string; found: false}

export type WorkspaceProbe =
  | {baseBranch?: string; branch?: string; found: true; workItemName?: string}
  | {error: string; found: false}

export type HelloReport = {
  auth: AuthRow[]
  cliVersion: string
  workItem: WorkItemProbe
  workspace: WorkspaceProbe
}

export function probeAcceptanceCriteria(item: PluginWorkItem): AcceptanceCriteriaProbe {
  const text = item.acceptanceCriteria?.trim() ?? ''
  if (text.length === 0) return {length: 0, lineCount: 0, present: false}
  const lineCount = text.split(/\r?\n/).filter((line) => line.trim().length > 0).length
  return {length: text.length, lineCount, present: true, text}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Chunk 1 spike: report what the host API exposes on this machine.
 * Never throws for a missing story or workspace; those are reported as data so the spike always prints.
 */
export async function buildHelloReport(host: HelloHost, workItemId?: string): Promise<HelloReport> {
  const status = host.auth.status()
  const auth: AuthRow[] = Object.entries(status).map(([service, credential]) => ({
    configured: credential.configured ? 'yes' : 'no',
    ready: credential.ready === undefined ? '-' : credential.ready ? 'yes' : 'no',
    service,
    source: credential.source ?? '-',
  }))

  let workspace: WorkspaceProbe
  try {
    const current = await host.workspace.current()
    workspace = {baseBranch: current.baseBranch, branch: current.branch, found: true, workItemName: current.workItemName}
  } catch (error) {
    workspace = {error: errorMessage(error), found: false}
  }

  let workItem: WorkItemProbe
  try {
    const item = await host.work.getWorkItem(workItemId)
    workItem = {
      acceptanceCriteria: probeAcceptanceCriteria(item),
      found: true,
      id: item.id,
      name: item.name,
      status: item.status,
      title: item.title,
    }
  } catch (error) {
    workItem = {error: errorMessage(error), found: false}
  }

  return {auth, cliVersion: host.cliVersion, workItem, workspace}
}
