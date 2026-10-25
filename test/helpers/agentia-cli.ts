import {execFile, execFileSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {delimiter, dirname, isAbsolute, join} from 'node:path'
import {promisify} from 'node:util'

const run = promisify(execFile)

/** Path or name of the real Agentia CLI. Override with AGENTIA_BIN; defaults to `agentia` on PATH. */
export const AGENTIA_BIN = process.env.AGENTIA_BIN ?? 'agentia'

export type CliResult = {code: number; stderr: string; stdout: string}

/**
 * How to launch the CLI without a shell. On Windows `agentia` is an npm `.cmd` shim, and launching a `.cmd`
 * needs a shell (Node warns about that: DEP0190). The shim only runs `node <cli>/bin/run.js`, so we find run.js
 * next to the shim and run it with Node directly. Arguments with spaces then need no quoting.
 */
function launcher(): {args: string[]; command: string; shell: boolean} {
  if (AGENTIA_BIN.endsWith('.js')) return {args: [AGENTIA_BIN], command: process.execPath, shell: false}
  if (process.platform !== 'win32') return {args: [], command: AGENTIA_BIN, shell: false}
  try {
    const shim = execFileSync('where', [AGENTIA_BIN], {encoding: 'utf8'}).split(/\r?\n/).find((line) => line.toLowerCase().endsWith('.cmd'))
    const runJs = shim ? join(dirname(shim), 'node_modules', '@copado', 'agentia-cli', 'bin', 'run.js') : undefined
    if (runJs && existsSync(runJs)) return {args: [runJs], command: process.execPath, shell: false}
  } catch {
    // fall through to the shell launch below
  }
  return {args: [], command: AGENTIA_BIN, shell: true}
}

const launch = launcher()

/**
 * Quality gate scripts call `agentia` by name. When AGENTIA_BIN is a full path, put its folder first on PATH so the
 * gate runs the same CLI as the test, not another install.
 */
function childEnv(): NodeJS.ProcessEnv {
  // Tests run in temp folders. GIT_CEILING_DIRECTORIES stops Git from searching above the temp folder, so a stray
  // repository in a parent folder (for example a home folder that is a Git repo) cannot change the results.
  const env: NodeJS.ProcessEnv = {...process.env, GIT_CEILING_DIRECTORIES: tmpdir(), NO_COLOR: '1'}
  if (!isAbsolute(AGENTIA_BIN) || AGENTIA_BIN.endsWith('.js')) return env
  // Windows names it "Path"; keep whichever key exists rather than adding a second one.
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[key] = `${dirname(AGENTIA_BIN)}${delimiter}${env[key] ?? ''}`
  return env
}

/** Run the real Agentia CLI. Integration tests only. Never used by plugin code (the SDK forbids that). */
export async function agentia(args: string[], options: {cwd?: string} = {}): Promise<CliResult> {
  try {
    const {stderr, stdout} = await run(launch.command, [...launch.args, ...args], {
      cwd: options.cwd,
      env: childEnv(),
      maxBuffer: 10 * 1024 * 1024,
      shell: launch.shell,
      timeout: 120_000,
    })
    return {code: 0, stderr: oneLine(stderr), stdout}
  } catch (error) {
    const e = error as {code?: number; stderr?: string; stdout?: string}
    return {code: typeof e.code === 'number' ? e.code : 1, stderr: oneLine(e.stderr ?? ''), stdout: e.stdout ?? ''}
  }
}

/** Parse the JSON envelope printed by `--json` commands: {status, result, transactionId} or {error, ...}. */
export function parseEnvelope(stdout: string): {error?: {message: string}; result: Record<string, unknown>; status: number} {
  const start = stdout.indexOf('{')
  if (start === -1) throw new Error(`No JSON in output:\n${stdout}`)
  return JSON.parse(stdout.slice(start))
}

/**
 * oclif wraps long warnings and errors to the terminal width, starting each continuation line with " ›   " (or " »   "
 * on Windows), so where a message breaks depends on the path length. Join the pieces back into one line for matching.
 * `agentia()` already does this for stderr (where errors go); stdout stays raw because it carries the JSON envelope.
 */
export const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*[›»]?\s*/g, ' ').replace(/^\s*[›»]\s*/, '').replace(/\s+/g, ' ').trim()
