import {cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

// Short folder names on purpose: Windows limits paths to 260 characters, and a fresh clone (or npm's Git install cache)
// adds its own folder in front of these fixture paths.
export const FIXTURE_PROJECTS = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fx')
const FOLDERS = {'agent-script-recipes': 'agent-script-recipes', 'coral-cloud': 'cc'} as const

export const fixtureProject = (name: 'agent-script-recipes' | 'coral-cloud'): string => join(FIXTURE_PROJECTS, FOLDERS[name])

/** A throwaway copy of a fixture project that a test may modify. Call `cleanup()` when done. */
export function tempProject(name: 'agent-script-recipes' | 'coral-cloud') {
  const root = mkdtempSync(join(tmpdir(), `passport-${name}-`))
  cpSync(fixtureProject(name), root, {recursive: true})
  return {
    cleanup: () => rmSync(root, {force: true, recursive: true}),
    edit(relativePath: string, change: (text: string) => string) {
      const file = join(root, ...relativePath.split('/'))
      writeFileSync(file, change(readFileSync(file, 'utf8')))
    },
    remove: (relativePath: string) => rmSync(join(root, ...relativePath.split('/')), {force: true, recursive: true}),
    root,
    write: (relativePath: string, text: string) => writeFileSync(join(root, ...relativePath.split('/')), text),
  }
}

export const CSA_AGENT_FILE = 'force-app-service/customerServiceAgent/aiAuthoringBundles/CustomerServiceAgent/CustomerServiceAgent.agent'
