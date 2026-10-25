import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, isAbsolute, join} from 'node:path'

import type {AgentGraph} from './model.ts'
import {ProjectError} from './project.ts'

/**
 * Golden conversations: test chats an agent must keep passing before it may be promoted.
 * Stored as JSON in passport/goldens/<agent>.json, reviewed like code.
 */

export type Expectation = {
  /** Actions that must not run (for example escalate_case on a simple question). */
  actionsExclude?: string[]
  /** Actions that must run during this turn. */
  actionsInclude?: string[]
  /** Fail if any action received an unfilled merge field such as `{!state.issue_type}`. Default true. */
  inputsResolved?: boolean
  /** Regular expression (case-insensitive) the reply must match. */
  replyMatches?: string
  /** Regular expression (case-insensitive) the reply must not match. */
  replyNotMatches?: string
  /** Subagent (Agent Script) or topic (classic) the turn must route to. */
  topic?: string
}

export type GoldenTurn = {expect: Expectation; utterance: string | null}

export type Golden = {
  /** The acceptance criterion this conversation proves, word for word. */
  criterion?: string
  id: string
  /** Why a person (or the coding agent) must look at this golden before it can run. */
  needsReview?: string[]
  story?: string
  turns: GoldenTurn[]
}

export type GoldenSuite = {
  agent: string
  /** Authoring bundle (Agent Script) or bot (classic) to preview. */
  bundle: string
  conversations: Golden[]
  /** Fraction of runs that must pass, 0 to 1. LLM routing varies, so each conversation runs several times. */
  passThreshold: number
  runsPerConversation: number
  schemaVersion: 1
}

/** Split acceptance criteria into single criteria: by line, bullet, and sentence (Copado often stores them as one line). */
export function splitCriteria(text: string): string[] {
  return text
    .split(/\r?\n/)
    .flatMap((line) => line.replace(/^\s*(?:[-*•]|\d+[.)]|AC-?\d+:?)\s*/i, '').split(/(?<=[.!?])\s+(?=[A-Z0-9"'])|;\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Reduce a word to a shared base so "creates", "created", "creating" and "create" all compare equal. */
export const stem = (word: string): string => {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (w.length < 4) return w
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`
  return w.replace(/(ing|ed|es|e|s)$/, '')
}
const stems = (text: string): Set<string> => new Set(text.split(/[^A-Za-z0-9]+/).filter(Boolean).map(stem))
const NEGATION = /\b(not|never|no|without|must not|should not|doesn't|does not)\b/i

/** Subagents (topics) and actions an agent can use, as the names its traces report. */
export function vocabulary(graph: AgentGraph): {actions: string[]; topics: string[]} {
  if (graph.model === 'agent-script') {
    const prefix = `${graph.agent}.`
    return {
      actions: [...new Set(graph.nodes.filter((n) => n.type === 'AgentAction').map((n) => n.name.split('.').at(-1)!))],
      topics: graph.nodes.filter((n) => n.type === 'Subagent' && n.status === 'present' && n.detail?.kind !== 'start_agent').map((n) => n.name.slice(prefix.length)),
    }
  }
  return {
    actions: graph.nodes.filter((n) => n.type === 'GenAiFunction').map((n) => n.name),
    topics: graph.nodes.filter((n) => n.type === 'GenAiPlugin').map((n) => n.name),
  }
}

/** Match one criterion to the agent's real subagent and action names. Deterministic, so the same criteria give the same goldens. */
export function expectationFor(criterion: string, graph: AgentGraph): {expect: Expectation; matched: boolean} {
  const words = stems(criterion)
  const lower = criterion.toLowerCase()
  const {actions, topics} = vocabulary(graph)
  const expect: Expectation = {inputsResolved: true}
  const topic = topics.find((t) => new RegExp(`\\b${t.toLowerCase().replace(/_/g, '[ _]')}\\b`).test(lower))
  if (topic) expect.topic = topic
  const named = actions.filter((a) => a.split(/_+/).filter(Boolean).every((part) => words.has(stem(part))))
  if (named.length > 0) {
    if (NEGATION.test(criterion)) expect.actionsExclude = named
    else expect.actionsInclude = named
  }
  return {expect, matched: Boolean(topic) || named.length > 0}
}

export function draftSuite(graph: AgentGraph, criteria: string[], options: {passThreshold?: number; runs?: number; story?: string} = {}): GoldenSuite {
  const bundle = graph.nodes.find((n) => n.type === 'AiAuthoringBundle' || n.type === 'Bot')?.name ?? graph.agent
  const conversations: Golden[] = criteria.map((criterion, i) => {
    const {expect, matched} = expectationFor(criterion, graph)
    const needsReview = ['Write the customer message (utterance) that tests this criterion.']
    if (!matched) needsReview.push('No subagent or action is named in this criterion; add the expectation by hand (topic, actionsInclude, replyMatches).')
    return {criterion, id: `AC-${i + 1}`, needsReview, story: options.story, turns: [{expect, utterance: null}]}
  })
  if (conversations.length === 0) {
    // No acceptance criteria: one starter conversation per subagent, so every route gets tested.
    for (const topic of vocabulary(graph).topics) {
      conversations.push({id: `ROUTE-${topic}`, needsReview: [`Write a customer message that should route to "${topic}".`], turns: [{expect: {inputsResolved: true, topic}, utterance: null}]})
    }
  }
  return {agent: graph.agent, bundle, conversations, passThreshold: options.passThreshold ?? 1, runsPerConversation: options.runs ?? 3, schemaVersion: 1}
}

/** Problems that stop a suite from running: unwritten utterances, names the agent does not have, broken patterns. */
export function validateSuite(suite: GoldenSuite, graph?: AgentGraph): string[] {
  const problems: string[] = []
  if (suite.schemaVersion !== 1) problems.push(`Unsupported schemaVersion ${String(suite.schemaVersion)}.`)
  if (!Number.isInteger(suite.runsPerConversation) || suite.runsPerConversation < 1) problems.push('runsPerConversation must be a whole number of at least 1.')
  if (typeof suite.passThreshold !== 'number' || suite.passThreshold <= 0 || suite.passThreshold > 1) problems.push('passThreshold must be more than 0 and at most 1.')
  if (!Array.isArray(suite.conversations) || suite.conversations.length === 0) problems.push('The suite has no conversations.')
  const vocab = graph ? vocabulary(graph) : undefined
  const ids = new Set<string>()
  for (const g of suite.conversations ?? []) {
    if (ids.has(g.id)) problems.push(`Duplicate conversation id ${g.id}.`)
    ids.add(g.id)
    if (!Array.isArray(g.turns) || g.turns.length === 0) problems.push(`${g.id}: no turns.`)
    for (const [t, turn] of (g.turns ?? []).entries()) {
      const where = `${g.id} turn ${t + 1}`
      if (typeof turn.utterance !== 'string' || turn.utterance.trim() === '') problems.push(`${where}: utterance is not written yet.`)
      const e = turn.expect ?? {}
      if (!e.topic && !e.actionsInclude?.length && !e.actionsExclude?.length && !e.replyMatches && !e.replyNotMatches) problems.push(`${where}: has no expectation to check.`)
      for (const pattern of [e.replyMatches, e.replyNotMatches]) {
        if (pattern === undefined) continue
        try {
          new RegExp(pattern, 'i')
        } catch {
          problems.push(`${where}: "${pattern}" is not a valid regular expression.`)
        }
      }
      if (vocab) {
        if (e.topic && !vocab.topics.includes(e.topic)) problems.push(`${where}: the agent has no subagent or topic "${e.topic}" (has: ${vocab.topics.join(', ')}).`)
        for (const a of [...(e.actionsInclude ?? []), ...(e.actionsExclude ?? [])]) {
          if (!vocab.actions.includes(a)) problems.push(`${where}: the agent has no action "${a}".`)
        }
      }
    }
  }
  return problems
}

export const goldensPath = (agent: string): string => join('passport', 'goldens', `${agent}.json`)

export function loadSuite(projectRoot: string, agent: string, path?: string): {file: string; suite: GoldenSuite} {
  const relative = path ?? goldensPath(agent)
  const file = isAbsolute(relative) ? relative : join(projectRoot, relative)
  if (!existsSync(file)) throw new ProjectError(`No golden conversations at ${file}. Create them with \`agentia passport goldens init --agent ${agent}\`.`)
  try {
    return {file, suite: JSON.parse(readFileSync(file, 'utf8')) as GoldenSuite}
  } catch (error) {
    throw new ProjectError(`${file} is not valid JSON: ${(error as Error).message}`)
  }
}

export function saveSuite(projectRoot: string, suite: GoldenSuite, path?: string): string {
  const relative = path ?? goldensPath(suite.agent)
  const file = isAbsolute(relative) ? relative : join(projectRoot, relative)
  mkdirSync(dirname(file), {recursive: true})
  writeFileSync(file, `${JSON.stringify(suite, null, 2)}\n`, 'utf8')
  return file
}

/** Quote an utterance so the same command works in PowerShell and POSIX shells (inner double quotes become single quotes). */
const quote = (value: string): string => `"${value.replace(/"/g, "'")}"`

export type RunPlan = {commands: string[]; conversation: string; run: number}

/**
 * The exact `sf agent preview` commands that produce the sessions `passport stamp` reads. Each run is one session:
 * start, send every turn, end. Sessions are started one at a time, so `send` and `end` need no session id.
 */
export function runPlan(suite: GoldenSuite, org: string, options: {simulate?: boolean} = {}): RunPlan[] {
  const mode = options.simulate ? '--simulate-actions' : '--use-live-actions'
  const plans: RunPlan[] = []
  for (const g of suite.conversations) {
    for (let run = 1; run <= suite.runsPerConversation; run++) {
      plans.push({
        commands: [
          `sf agent preview start --authoring-bundle ${suite.bundle} ${mode} --target-org ${org} --json`,
          ...g.turns.map((t) => `sf agent preview send --authoring-bundle ${suite.bundle} --target-org ${org} --utterance ${quote(t.utterance ?? '<WRITE THE UTTERANCE FIRST>')} --json`),
          `sf agent preview end --authoring-bundle ${suite.bundle} --target-org ${org} --json`,
        ],
        conversation: g.id,
        run,
      })
    }
  }
  return plans
}
