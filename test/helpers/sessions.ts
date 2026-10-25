import {chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * Real `sf agent preview` session folders, saved from a Developer Edition org. The published agent's record Id was
 * replaced; they contain no emails, usernames, tokens or customer records.
 */
export const SESSION_FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'sessions')

const sessionsDir = (projectRoot: string, agentId: string) => join(projectRoot, '.sfdx', 'agents', agentId, 'sessions')

function makeWritable(dir: string): void {
  for (const entry of readdirSync(dir, {recursive: true, withFileTypes: true})) {
    if (entry.isFile()) chmodSync(join(entry.parentPath, entry.name), 0o666)
  }
}

/** Copy a real session into a project as a new run, with its own id and start time. */
export function copySession(projectRoot: string, fixture: 'bundle-live' | 'published-agent' | 'simulated', agentId: string, sessionId: string, startTime: string): string {
  const dir = join(sessionsDir(projectRoot, agentId), sessionId)
  cpSync(join(SESSION_FIXTURES, fixture), dir, {recursive: true})
  // A copy keeps the source's read-only flag, and Windows then refuses the overwrite below (root on Linux does not).
  makeWritable(dir)
  const meta = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'))
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({...meta, sessionId, startTime}))
  return dir
}

export type FakeTurn = {actions?: Array<{input?: unknown; name: string}>; reply: string; topic?: string; transitions?: string[]; utterance: string}

/** Write a session in the same file layout real previews use (metadata, transcript, turn-index, one trace per turn). */
export function writeSession(projectRoot: string, agentId: string, sessionId: string, startTime: string, turns: FakeTurn[], mode = 'Live Test'): string {
  const dir = join(sessionsDir(projectRoot, agentId), sessionId)
  mkdirSync(join(dir, 'traces'), {recursive: true})
  const transcript = [{role: 'agent', text: 'Hi, how can I help?'}]
  const index: Array<Record<string, unknown>> = [{role: 'agent', traceFile: null, turn: 1}]
  turns.forEach((t, i) => {
    const planId = `${sessionId}-plan-${i + 1}`
    transcript.push({role: 'user', text: t.utterance}, {role: 'agent', text: t.reply})
    index.push({role: 'user', summary: t.utterance, traceFile: null, turn: index.length + 1}, {planId, role: 'agent', traceFile: `traces/${planId}.json`, turn: index.length + 2})
    const plan = [
      ...(t.transitions ?? []).map((to) => ({data: {from_agent: 'Agent Router', to_agent: to}, type: 'TransitionStep'})),
      ...(t.actions ?? []).map((a) => ({executionLatency: 100, function: {input: a.input ?? {}, name: a.name, output: {}}, type: 'FunctionStep'})),
      {type: 'PlannerResponseStep'},
    ]
    writeFileSync(join(dir, 'traces', `${planId}.json`), JSON.stringify({intent: t.topic, plan, planId, sessionId, topic: t.topic, type: 'PlanSuccessResponse'}))
  })
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({agentId, mockMode: mode, planIds: [], sessionId, startTime}))
  writeFileSync(join(dir, 'transcript.jsonl'), transcript.map((t) => JSON.stringify({...t, agentId, sessionId})).join('\n') + '\n')
  writeFileSync(join(dir, 'turn-index.json'), JSON.stringify({agentId, sessionId, turns: index, version: '1.0'}))
  return dir
}
