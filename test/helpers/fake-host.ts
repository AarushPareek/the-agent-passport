import type {PluginAuthStatus, PluginWorkItem, PluginWorkspace} from '@copado/agentia-plugin-sdk'

import type {HelloHost} from '../../src/core/hello.ts'

export type FakeHostOptions = {
  auth?: PluginAuthStatus
  workItem?: PluginWorkItem | Error
  workspace?: PluginWorkspace | Error
}

const defaultAuth: PluginAuthStatus = {
  ai: {configured: false},
  cicd: {configured: true, source: 'global'},
  crt: {configured: false, ready: false, source: 'global'},
}

/** A stand-in for the object the Agentia CLI registers at runtime. Records calls so tests can assert on them. */
export function fakeHost(options: FakeHostOptions = {}) {
  const calls: {getWorkItem: Array<string | undefined>} = {getWorkItem: []}
  const host = {
    auth: {status: () => options.auth ?? defaultAuth},
    cliVersion: '1.1.0-test',
    work: {
      async getWorkItem(id?: string) {
        calls.getWorkItem.push(id)
        const item = options.workItem ?? new Error('No active work item. Run `agentia cicd work set <id>` or pass a user story ID.')
        if (item instanceof Error) throw item
        return item
      },
      async list() {
        return []
      },
    },
    workspace: {
      async current() {
        const ws = options.workspace ?? {defaults: {}}
        if (ws instanceof Error) throw ws
        return ws
      },
    },
  } satisfies HelloHost
  return {calls, host}
}
