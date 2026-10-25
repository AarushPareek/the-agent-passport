import {execFileSync} from 'node:child_process'

/**
 * Read-only Git helpers. The plugin runs `git` itself (declared in package.json "agentia.permissions.commands").
 * It never runs `agentia` as a subprocess, which the plugin SDK forbids.
 */
export class GitError extends Error {}

export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']})
  } catch (error) {
    const e = error as {stderr?: string; message: string}
    throw new GitError(`git ${args.join(' ')} failed: ${(e.stderr ?? e.message).trim()}`)
  }
}

const lines = (out: string): string[] => out.split(/\r?\n/).filter((l) => l.length > 0)

export function isRepository(cwd: string): boolean {
  try {
    return git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'
  } catch {
    return false
  }
}

/** Path of `cwd` relative to the repository root, with a trailing slash ('' at the root). */
export function prefixInRepo(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-prefix']).trim()
}

function refExists(cwd: string, ref: string): boolean {
  try {
    git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return true
  } catch {
    return false
  }
}

/**
 * The commit that represents a branch: the remote-tracking `origin/<branch>` when present (what the target environment
 * was last fetched as), otherwise the local branch. Pass `fetch` to update `origin/<branch>` first.
 */
export function resolveBranch(cwd: string, branch: string, options: {fetch?: boolean} = {}): string {
  if (options.fetch) git(cwd, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`, branch]) {
    if (refExists(cwd, ref)) return ref.replace(/^refs\/(remotes|heads)\//, '')
  }
  throw new GitError(`Branch "${branch}" was not found locally or as origin/${branch}. Run \`git fetch origin ${branch}\` or pass --fetch.`)
}

/** Every file path on a commit, relative to the repository root. */
export function listFiles(cwd: string, ref: string): string[] {
  return lines(git(cwd, ['ls-tree', '-r', '--name-only', '--full-tree', ref]))
}

/** Read one file at a commit, or undefined if it does not exist there. */
export function readAt(cwd: string, ref: string, path: string): string | undefined {
  try {
    return git(cwd, ['show', `${ref}:${path}`])
  } catch {
    return undefined
  }
}

/** Files the current branch changed since it left `targetRef` (committed only): what a promotion would carry. */
export function committedChanges(cwd: string, targetRef: string): {changed: string[]; deleted: string[]} {
  const out = lines(git(cwd, ['diff', '--name-status', '--no-renames', '--full-index', `${targetRef}...HEAD`]))
  const changed: string[] = []
  const deleted: string[] = []
  for (const line of out) {
    const [status, path] = line.split('\t')
    if (status === 'D') deleted.push(path)
    else if (path) changed.push(path)
  }
  return {changed, deleted}
}

/** Tracked files with uncommitted edits, plus untracked files Git does not ignore. Repository-relative paths. */
export function uncommittedFiles(cwd: string): string[] {
  const modified = lines(git(cwd, ['diff', '--name-only', '--full-index', 'HEAD']))
  const untracked = lines(git(cwd, ['ls-files', '--others', '--exclude-standard', '--full-name']))
  return [...new Set([...modified, ...untracked])]
}

export function currentBranch(cwd: string): string | undefined {
  try {
    const name = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    return name === 'HEAD' ? undefined : name
  } catch {
    return undefined
  }
}
