import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'

import type {Expectation, Golden, GoldenSuite, GoldenTurn} from './goldens.ts'
import {loadSuite, validateSuite} from './goldens.ts'
import type {AgentGraph} from './model.ts'
import {ProjectError} from './project.ts'
import {runScan, TOOL} from './scan.ts'
import type {PreviewSession, SessionTurn} from './session.ts'
import type {TravelResult} from './travel.ts'
import {listSessions} from './session.ts'

/**
 * Stamping: score saved preview sessions against the golden conversations and grant (or refuse) a stamp for one
 * environment. A stamp records a fingerprint of the agent's files, so `verify` can tell when it no longer applies.
 */

export type Check = {detail: string; name: string; passed: boolean}

export type RunResult = {checks: Check[]; mode?: string; passed: boolean; sessionId: string; startTime?: string}

export type GoldenResult = {
  criterion?: string
  id: string
  passed: boolean
  passRate: number
  /** Present when the baseline says this conversation used to pass, or routed differently. */
  regression?: 'route-changed' | 'was-passing'
  required: number
  runs: RunResult[]
  /** Subagents and actions most runs used, kept as the next baseline. */
  observed: {actions: string[]; topics: string[]}
}

export type Stamp = {
  agent: string
  environment: string
  fingerprint: string
  goldens: GoldenResult[]
  /** Hash of the golden conversations file, so editing the tests after stamping also makes the stamp stale. */
  goldensHash: string
  /** `live` when every run used real actions, `simulated` when any run used `--simulate-actions`. */
  mode: 'live' | 'simulated'
  passThreshold: number
  problems: string[]
  schemaVersion: 1
  stampedAt: string
  tool: string
  verdict: 'refused' | 'stamped'
}

export type Baseline = {agent: string; conversations: Record<string, {actions: string[]; passed: boolean; topics: string[]}>; schemaVersion: 1; source: string}

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase()
const MERGE_FIELD = /\{![^}]*\}/

/** Score one session turn against its expectation. */
export function checkTurn(turn: SessionTurn | undefined, golden: GoldenTurn, index: number): Check[] {
  const at = `turn ${index + 1}`
  if (!turn) return [{detail: `${at}: the session has no reply for this turn`, name: 'turn', passed: false}]
  if (turn.traceStatus !== 'ok') {
    return [
      {
        detail: `${at}: no trace data (${turn.traceStatus}). Published-agent previews save empty traces; preview the authoring bundle (sf agent preview start --authoring-bundle ...).`,
        name: 'trace',
        passed: false,
      },
    ]
  }
  const e: Expectation = golden.expect ?? {}
  const checks: Check[] = []
  const used = turn.actions.map((a) => a.name)
  const route = [...turn.transitions, ...(turn.topic ? [turn.topic] : [])]
  if (e.topic) {
    const ok = route.some((t) => t.toLowerCase() === e.topic!.toLowerCase())
    checks.push({detail: ok ? `${at}: routed to ${e.topic}` : `${at}: expected subagent "${e.topic}", routed to ${route.join(' -> ') || 'nothing'}`, name: 'topic', passed: ok})
  }
  for (const a of e.actionsInclude ?? []) {
    const ok = used.includes(a)
    checks.push({detail: ok ? `${at}: ran ${a}` : `${at}: expected action "${a}" to run; ran ${used.join(', ') || 'no actions'}`, name: 'action', passed: ok})
  }
  for (const a of e.actionsExclude ?? []) {
    const ok = !used.includes(a)
    checks.push({detail: ok ? `${at}: did not run ${a}` : `${at}: action "${a}" must not run, but it did`, name: 'action-excluded', passed: ok})
  }
  if (e.inputsResolved !== false) {
    const bad = turn.actions.filter((a) => MERGE_FIELD.test(JSON.stringify(a.input ?? '')))
    checks.push({
      detail: bad.length === 0 ? `${at}: every action input was filled in` : `${at}: unfilled merge field in the input of ${bad.map((a) => `${a.name} (${JSON.stringify(a.input).match(MERGE_FIELD)?.[0]})`).join(', ')}`,
      name: 'inputs-resolved',
      passed: bad.length === 0,
    })
  }
  const reply = turn.reply ?? ''
  if (e.replyMatches) {
    const ok = new RegExp(e.replyMatches, 'i').test(reply)
    checks.push({detail: ok ? `${at}: reply matches /${e.replyMatches}/` : `${at}: reply does not match /${e.replyMatches}/`, name: 'reply', passed: ok})
  }
  if (e.replyNotMatches) {
    const ok = !new RegExp(e.replyNotMatches, 'i').test(reply)
    checks.push({detail: ok ? `${at}: reply avoids /${e.replyNotMatches}/` : `${at}: reply must not match /${e.replyNotMatches}/`, name: 'reply-excluded', passed: ok})
  }
  return checks
}

/** Does this session replay this golden conversation (same utterances, in order)? */
export function sessionMatches(session: PreviewSession, golden: Golden): boolean {
  if (session.turns.length < golden.turns.length) return false
  return golden.turns.every((t, i) => typeof t.utterance === 'string' && norm(session.turns[i].utterance) === norm(t.utterance))
}

export function scoreRun(session: PreviewSession, golden: Golden): RunResult {
  const checks = golden.turns.flatMap((t, i) => checkTurn(session.turns[i], t, i))
  return {checks, mode: session.mode, passed: checks.length > 0 && checks.every((c) => c.passed), sessionId: session.sessionId, startTime: session.startTime}
}

function mostCommon(lists: string[][]): string[] {
  const counts = new Map<string, {list: string[]; n: number}>()
  for (const list of lists) {
    const key = list.join('|')
    counts.set(key, {list, n: (counts.get(key)?.n ?? 0) + 1})
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.list ?? []
}

/**
 * Fingerprint of everything the agent is made of: the agent file and every dependency file in the project.
 * Line endings are normalised so a Windows checkout and a Linux checkout give the same value.
 */
export function fingerprint(projectRoot: string, graph: AgentGraph): string {
  const paths = [...new Set(graph.nodes.filter((n) => n.status === 'present').flatMap((n) => n.locations.map((l) => l.path)))].sort()
  const hash = createHash('sha256')
  for (const path of paths) {
    hash.update(path)
    hash.update('\0')
    hash.update(readFileSync(join(projectRoot, ...path.split('/')), 'utf8').replace(/\r\n/g, '\n'))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

export const hashText = (text: string): string => `sha256:${createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')}`

export const stampPath = (environment: string, agent: string): string => join('passport', 'stamps', environment.replace(/[^A-Za-z0-9._-]+/g, '_'), `${agent}.json`)
export const baselinePath = (agent: string): string => join('passport', 'baselines', `${agent}.json`)

function readJsonFile<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

const writeJsonFile = (file: string, value: unknown): void => {
  mkdirSync(dirname(file), {recursive: true})
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export type StampOptions = {
  agent: string
  environment: string
  goldensFile?: string
  now?: Date
  /** Only use sessions that started at or after this time (ISO 8601). */
  since?: string
  /** Replace the baseline with this run's observations when the stamp is granted. */
  updateBaseline?: boolean
}

export function runStamp(projectRoot: string, options: StampOptions): {baselineWritten?: string; stamp: Stamp; stampFile: string} {
  const scan = runScan(projectRoot, {agent: options.agent})
  if (scan.agents.length !== 1) throw new ProjectError(`"${options.agent}" matches ${scan.agents.length} agents; name one.`)
  const graph = scan.agents[0]
  const {file: goldensFile, suite} = loadSuite(projectRoot, graph.agent, options.goldensFile)
  const problems = validateSuite(suite, graph)

  const sessions = listSessions(projectRoot, suite.bundle).filter((s) => !options.since || (s.startTime ?? '') >= options.since)
  const baselineFile = join(projectRoot, baselinePath(graph.agent))
  const baseline = readJsonFile<Baseline>(baselineFile)

  const goldens: GoldenResult[] = suite.conversations.map((g) => {
    const matching = sessions.filter((s) => sessionMatches(s, g))
    const runs = matching.slice(-suite.runsPerConversation).map((s) => scoreRun(s, g))
    const passes = runs.filter((r) => r.passed).length
    const passRate = runs.length === 0 ? 0 : passes / runs.length
    const used = matching.slice(-suite.runsPerConversation)
    const observed = {
      actions: mostCommon(used.map((s) => s.turns.slice(0, g.turns.length).flatMap((t) => t.actions.map((a) => a.name)))),
      topics: mostCommon(used.map((s) => s.turns.slice(0, g.turns.length).flatMap((t) => [...t.transitions, ...(t.topic ? [t.topic] : [])]))),
    }
    const passed = runs.length >= suite.runsPerConversation && passRate >= suite.passThreshold
    const result: GoldenResult = {criterion: g.criterion, id: g.id, observed, passed, passRate, required: suite.runsPerConversation, runs}
    const before = baseline?.conversations[g.id]
    if (before?.passed && !passed) result.regression = 'was-passing'
    else if (before && runs.length > 0 && before.topics.join('|') !== observed.topics.join('|')) result.regression = 'route-changed'
    if (runs.length < suite.runsPerConversation) problems.push(`${g.id}: ${runs.length} of ${suite.runsPerConversation} runs found. Run \`agentia passport goldens plan\` and execute the missing runs.`)
    return result
  })

  const mode: Stamp['mode'] = goldens.some((g) => g.runs.some((r) => r.mode === 'Mock')) ? 'simulated' : 'live'
  const stamp: Stamp = {
    agent: graph.agent,
    environment: options.environment,
    fingerprint: fingerprint(projectRoot, graph),
    goldens,
    goldensHash: hashText(readFileSync(goldensFile, 'utf8')),
    mode,
    passThreshold: suite.passThreshold,
    problems,
    schemaVersion: 1,
    stampedAt: (options.now ?? new Date()).toISOString(),
    tool: TOOL,
    verdict: problems.length === 0 && goldens.every((g) => g.passed) ? 'stamped' : 'refused',
  }
  const stampFile = join(projectRoot, stampPath(options.environment, graph.agent))
  writeJsonFile(stampFile, stamp)

  let baselineWritten: string | undefined
  if (stamp.verdict === 'stamped' && (options.updateBaseline || !baseline)) {
    const next: Baseline = {
      agent: graph.agent,
      conversations: Object.fromEntries(goldens.map((g) => [g.id, {actions: g.observed.actions, passed: g.passed, topics: g.observed.topics}])),
      schemaVersion: 1,
      source: `${options.environment} stamp at ${stamp.stampedAt}`,
    }
    writeJsonFile(baselineFile, next)
    baselineWritten = baselineFile
  }
  return {baselineWritten, stamp, stampFile}
}

export type VerifyCheck = {detail: string; name: 'scan' | 'stamp' | 'stamp-mode' | 'travel'; passed: boolean}
export type VerifyResult = {agent: string; checks: VerifyCheck[]; environment: string; passed: boolean}

export type VerifyOptions = {
  agent?: string
  environment: string
  goldensFile?: string
  requireLive?: boolean
  /** A travel result computed just now (the gate uses this, so nothing is written during `work submit`). */
  travel?: Pick<TravelResult, 'agents' | 'target'>
  /** A travel result saved earlier with `passport travel`. */
  travelFile?: string
}

type TravelLike = {agents: Array<{agent: string; items: Array<{component: string; status: string}>}>; target?: {branch?: string; environment?: string}}

function travelCheck(travel: TravelLike | undefined, agent: string, source: string): VerifyCheck {
  const mine = travel?.agents.find((a) => a.agent === agent)
  if (!travel) return {detail: `travel result ${source} not found or unreadable`, name: 'travel', passed: false}
  if (!mine) return {detail: `travel result has no entry for ${agent}`, name: 'travel', passed: false}
  const to = travel.target?.environment ?? travel.target?.branch ?? 'the target'
  const gaps = mine.items.filter((i) => i.status === 'gap').map((i) => i.component)
  return {detail: gaps.length === 0 ? `no travel gaps to ${to}` : `will not arrive in ${to}: ${gaps.join(', ')}`, name: 'travel', passed: gaps.length === 0}
}

function currentGoldensHash(projectRoot: string, agent: string, path?: string): string | undefined {
  try {
    return hashText(readFileSync(loadSuite(projectRoot, agent, path).file, 'utf8'))
  } catch {
    return undefined
  }
}

/** The gate: scan has no errors, the environment's stamp exists, was granted, and still matches the agent's files. */
export function runVerify(projectRoot: string, options: VerifyOptions): VerifyResult[] {
  const scan = runScan(projectRoot, {agent: options.agent})
  const results: VerifyResult[] = []
  for (const graph of scan.agents) {
    const checks: VerifyCheck[] = []
    const errors = scan.findings.filter((f) => f.agent === graph.agent && f.severity === 'error')
    checks.push({detail: errors.length === 0 ? 'no scan errors' : errors.map((f) => `${f.code}: ${f.message}`).join(' | '), name: 'scan', passed: errors.length === 0})

    const stamp = readJsonFile<Stamp>(join(projectRoot, stampPath(options.environment, graph.agent)))
    if (!stamp) {
      checks.push({detail: `no ${options.environment} stamp. Run the golden conversations, then \`agentia passport stamp --env ${options.environment} --agent ${graph.agent}\`.`, name: 'stamp', passed: false})
    } else if (stamp.verdict !== 'stamped') {
      const failing = stamp.goldens.filter((g) => !g.passed).map((g) => `${g.id} (${Math.round(g.passRate * 100)}%)`)
      checks.push({detail: `${options.environment} stamp was refused: ${[...failing, ...stamp.problems].join('; ')}`, name: 'stamp', passed: false})
    } else if (stamp.goldensHash !== currentGoldensHash(projectRoot, graph.agent, options.goldensFile)) {
      checks.push({detail: `${options.environment} stamp is stale: the golden conversations changed after ${stamp.stampedAt}. Re-run them and stamp again.`, name: 'stamp', passed: false})
    } else if (stamp.fingerprint !== fingerprint(projectRoot, graph)) {
      checks.push({detail: `${options.environment} stamp is stale: the agent or one of its dependencies changed after ${stamp.stampedAt}. Re-run the golden conversations and stamp again.`, name: 'stamp', passed: false})
    } else {
      checks.push({detail: `${options.environment} stamp granted ${stamp.stampedAt} (${stamp.goldens.length} conversation(s), ${stamp.mode})`, name: 'stamp', passed: true})
      if (options.requireLive) checks.push({detail: stamp.mode === 'live' ? 'stamp used live actions' : 'stamp used simulated actions; --require-live needs real actions', name: 'stamp-mode', passed: stamp.mode === 'live'})
    }

    if (options.travel) checks.push(travelCheck(options.travel, graph.agent, 'computed now'))
    else if (options.travelFile) checks.push(travelCheck(readJsonFile<TravelLike>(join(projectRoot, options.travelFile)), graph.agent, options.travelFile))
    results.push({agent: graph.agent, checks, environment: options.environment, passed: checks.every((c) => c.passed)})
  }
  return results
}
