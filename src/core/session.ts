import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'

/**
 * Reader for the session folders `sf agent preview` saves in a Salesforce DX project:
 *   .sfdx/agents/<agent>/sessions/<sessionId>/{metadata.json, transcript.jsonl, turn-index.json, traces/<planId>.json}
 * Field names are observed in real files (spike 03), not documented by Salesforce, so every lookup is defensive.
 */

export type SessionAction = {input: unknown; latencyMs?: number; name: string; output: unknown}

export type SessionTurn = {
  actions: SessionAction[]
  /** The agent's full reply text for this turn. */
  reply?: string
  /** Subagent (topic) the plan ended in. */
  topic?: string
  /** 'ok' = trace has plan steps; 'empty' = trace file is `{}` (published-agent previews); 'missing' = no trace file. */
  traceStatus: 'empty' | 'missing' | 'ok'
  /** Subagents the conversation moved to during this turn, in order. */
  transitions: string[]
  utterance: string
}

export type PreviewSession = {
  agentId?: string
  dir: string
  /** `Mock` (simulated actions), `Live Test` (authoring bundle with live actions), undefined for published agents. */
  mode?: string
  sessionId: string
  startTime?: string
  turns: SessionTurn[]
}

type Json = Record<string, unknown>
const readJson = (path: string): Json | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Json
  } catch {
    return undefined
  }
}
const asArray = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : [])
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

function readTranscript(dir: string): Array<{role: string; text: string}> {
  const file = join(dir, 'transcript.jsonl')
  if (!existsSync(file)) return []
  const out: Array<{role: string; text: string}> = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as Json
      out.push({role: String(entry.role ?? ''), text: String(entry.text ?? '')})
    } catch {
      // ignore a partial line
    }
  }
  return out
}

export function readSession(dir: string): PreviewSession {
  const metadata = readJson(join(dir, 'metadata.json')) ?? {}
  const index = readJson(join(dir, 'turn-index.json')) ?? {}
  const transcript = readTranscript(dir)

  // Pair each user message with the agent reply that follows it (the transcript has the full text).
  const replies: Array<{reply?: string; utterance: string}> = []
  for (let i = 0; i < transcript.length; i++) {
    if (transcript[i].role !== 'user') continue
    const next = transcript.slice(i + 1).find((t) => t.role === 'agent' || t.role === 'user')
    replies.push({reply: next?.role === 'agent' ? next.text : undefined, utterance: transcript[i].text})
  }

  // Agent entries in turn-index.json that answer a user message carry the trace file for that turn.
  const traceFiles: Array<string | undefined> = []
  let afterUser = false
  for (const entry of asArray(index.turns)) {
    if (entry.role === 'user') afterUser = true
    else if (entry.role === 'agent' && afterUser) {
      traceFiles.push(str(entry.traceFile))
      afterUser = false
    }
  }

  const turns: SessionTurn[] = replies.map((r, k) => {
    const turn: SessionTurn = {actions: [], reply: r.reply, traceStatus: 'missing', transitions: [], utterance: r.utterance}
    const traceFile = traceFiles[k]
    const trace = traceFile ? readJson(join(dir, ...traceFile.split('/'))) : undefined
    if (!trace) return turn
    const plan = asArray(trace.plan)
    turn.traceStatus = plan.length > 0 ? 'ok' : 'empty'
    turn.topic = str(trace.topic)
    for (const step of plan) {
      if (step.type === 'FunctionStep') {
        const fn = (step.function ?? {}) as Json
        turn.actions.push({input: fn.input, latencyMs: typeof step.executionLatency === 'number' ? step.executionLatency : undefined, name: String(fn.name), output: fn.output})
      } else if (step.type === 'TransitionStep') {
        const to = str(((step.data ?? {}) as Json).to_agent)
        if (to) turn.transitions.push(to)
      }
    }
    return turn
  })

  return {
    agentId: str(metadata.agentId),
    dir,
    mode: str(metadata.mockMode),
    sessionId: str(metadata.sessionId) ?? dir.split(/[\\/]/).at(-1) ?? '',
    startTime: str(metadata.startTime),
    turns,
  }
}

/** Every saved preview session for an agent in a DX project, oldest first. */
export function listSessions(projectRoot: string, agentId: string): PreviewSession[] {
  const base = join(projectRoot, '.sfdx', 'agents', agentId, 'sessions')
  if (!existsSync(base)) return []
  return readdirSync(base)
    .map((name) => join(base, name))
    .filter((dir) => statSync(dir).isDirectory() && existsSync(join(dir, 'metadata.json')))
    .map((dir) => readSession(dir))
    .sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''))
}
