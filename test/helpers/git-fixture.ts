import {execFileSync} from 'node:child_process'
import {mkdirSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {tempProject} from './fixtures.ts'

/**
 * A fixture project inside a real Git repository, for travel tests. Starts with a `main` branch that holds only a
 * README (an empty target environment). Tests then build the target and story branches they need.
 */
export function gitProject(name: 'agent-script-recipes' | 'coral-cloud') {
  const p = tempProject(name)
  const git = (...args: string[]) => execFileSync('git', args, {cwd: p.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'tests@example.invalid')
  git('config', 'user.name', 'tests')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(p.root, 'README.md'), 'target\n')
  git('add', 'README.md')
  git('commit', '-qm', 'empty target')
  return {
    ...p,
    /** Stage and commit the given paths (files or folders) on the current branch. */
    commit(message: string, ...paths: string[]) {
      git('add', '--', ...paths)
      git('commit', '-qm', message)
    },
    git,
    writeFile(relativePath: string, text: string) {
      const file = join(p.root, ...relativePath.split('/'))
      mkdirSync(dirname(file), {recursive: true})
      writeFileSync(file, text)
    },
  }
}
