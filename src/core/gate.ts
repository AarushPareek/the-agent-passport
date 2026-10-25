import {chmodSync, existsSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

/**
 * The Agent Passport block in Agentia's local quality gate scripts. `agentia cicd work test` runs
 * `.agentia_quality_gates.sh` (macOS/Linux) or `.agentia_quality_gates.cmd` (Windows) from the repository root, and
 * `agentia cicd work submit` runs it first and stops on a non-zero exit (spike 02). We only ever touch the lines between
 * our markers, so a project's existing gates (Apex tests, Code Analyzer, LWC tests) keep working.
 */

export const GATE_SH = '.agentia_quality_gates.sh'
export const GATE_CMD = '.agentia_quality_gates.cmd'
const BEGIN = '>>> agent-passport (managed by `agentia passport setup`; edit with setup, not by hand) >>>'
const END = '<<< agent-passport <<<'

export type GateOptions = {
  /** Only verify this agent (otherwise every agent in the project needs a stamp). */
  agent?: string
  /** Environment whose stamp is required, for example Passport-Dev. */
  environment: string
  /** Also reject stamps from simulated actions. */
  requireLive?: boolean
  /** Also check that everything the agent needs will arrive in this Copado environment... */
  travelTo?: string
  /** ...or on this Git branch (offline). */
  travelToBranch?: string
}

/** Characters that are safe unquoted in both shells; anything else is refused rather than escaped. */
const SAFE = /^[A-Za-z0-9._\-/:@ ]+$/

export function verifyArgs(options: GateOptions): string[] {
  for (const [name, value] of Object.entries(options)) {
    if (typeof value === 'string' && !SAFE.test(value)) throw new Error(`${name} "${value}" contains characters that are not allowed in a gate script.`)
  }
  const args = ['passport', 'verify', '--env', options.environment]
  if (options.agent) args.push('--agent', options.agent)
  if (options.travelTo) args.push('--travel-to', options.travelTo)
  else if (options.travelToBranch) args.push('--travel-to-branch', options.travelToBranch)
  if (options.requireLive) args.push('--require-live')
  return args
}

const quoted = (args: string[]): string => args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')

export function shBlock(options: GateOptions): string[] {
  return [
    `# ${BEGIN}`,
    '# Agent Passport: the agent must hold a current, granted stamp before this story moves on.',
    'echo "## Agent Passport: verifying the agent"',
    `agentia ${quoted(verifyArgs(options))} || exit $?`,
    `# ${END}`,
  ]
}

export function cmdBlock(options: GateOptions): string[] {
  return [
    `REM ${BEGIN}`,
    'REM Agent Passport: the agent must hold a current, granted stamp before this story moves on.',
    'echo ## Agent Passport: verifying the agent',
    // `call` is required: agentia is an npm .cmd shim, and without call this script would end after it.
    `call agentia ${quoted(verifyArgs(options))}`,
    'if errorlevel 1 exit /b %errorlevel%',
    `REM ${END}`,
  ]
}

const SH_HEADER = ['#!/usr/bin/env bash', 'set -euo pipefail', '', '# Local Agentia quality gates (macOS / Linux). Agentia runs this from the repo root during', '# `agentia cicd work test` and before `agentia cicd work submit`. Exit non-zero to stop.', '']
const CMD_HEADER = ['@echo off', 'setlocal EnableExtensions EnableDelayedExpansion', 'REM Local Agentia quality gates (Windows). Agentia runs this from the repo root during', 'REM `agentia cicd work test` and before `agentia cicd work submit`. Exit non-zero to stop.', '']

type Kind = 'cmd' | 'sh'

function blockRange(lines: string[]): [number, number] | undefined {
  const start = lines.findIndex((l) => l.includes(BEGIN))
  if (start === -1) return undefined
  const end = lines.findIndex((l, i) => i > start && l.includes(END))
  return end === -1 ? undefined : [start, end]
}

/** Where to put a new block in an existing script: after the shebang / `set` / `@echo off` / `setlocal` preamble, so it runs before any early `exit 0`. */
function insertAt(lines: string[], kind: Kind): number {
  const preamble = kind === 'sh' ? /^(#!|set\s+-|\s*$)/ : /^(@echo\s+off|setlocal\b|\s*$)/i
  let i = 0
  while (i < lines.length && preamble.test(lines[i])) i++
  return i
}

/** The new text of a gate script with our block added, replaced, or (block undefined) removed. */
export function withBlock(existing: string | undefined, kind: Kind, block: string[] | undefined): string | undefined {
  const eol = kind === 'cmd' ? '\r\n' : '\n'
  if (existing === undefined) {
    if (!block) return undefined
    return [...(kind === 'sh' ? SH_HEADER : CMD_HEADER), ...block, ''].join(eol)
  }
  const lines = existing.split(/\r?\n/)
  const range = blockRange(lines)
  if (range && block) lines.splice(range[0], range[1] - range[0] + 1, ...block)
  // Removing: also drop the blank line we added after the block, so the script is back to what it was.
  else if (range) lines.splice(range[0], range[1] - range[0] + 1 + (lines[range[1] + 1] === '' ? 1 : 0))
  else if (block) lines.splice(insertAt(lines, kind), 0, ...block, '')
  return lines.join(eol)
}

export type GateChange = {action: 'added' | 'created' | 'removed' | 'unchanged' | 'updated'; file: string}

/** Install (or with `options` undefined, remove) the Passport block in both gate scripts. Returns what changed. */
export function installGate(projectRoot: string, options: GateOptions | undefined): GateChange[] {
  const changes: GateChange[] = []
  for (const [file, kind] of [[GATE_SH, 'sh'], [GATE_CMD, 'cmd']] as const) {
    const path = join(projectRoot, file)
    const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined
    const block = options ? (kind === 'sh' ? shBlock(options) : cmdBlock(options)) : undefined
    const after = withBlock(before, kind, block)
    const hadBlock = before !== undefined && blockRange(before.split(/\r?\n/)) !== undefined
    if (after === undefined || after === before) {
      changes.push({action: 'unchanged', file})
      continue
    }
    writeFileSync(path, after, 'utf8')
    if (kind === 'sh') chmodSync(path, 0o755)
    changes.push({action: before === undefined ? 'created' : !options ? 'removed' : hadBlock ? 'updated' : 'added', file})
  }
  return changes
}

/** The verify command the gate currently runs, or undefined when the gate has no Passport block. */
export function installedGateCommand(projectRoot: string): string | undefined {
  const path = join(projectRoot, GATE_SH)
  if (!existsSync(path)) return undefined
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const range = blockRange(lines)
  return range ? lines.slice(range[0], range[1]).find((l) => l.startsWith('agentia '))?.replace(/ \|\| exit \$\?$/, '') : undefined
}
