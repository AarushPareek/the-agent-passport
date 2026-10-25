import assert from 'node:assert/strict'
import {join} from 'node:path'
import {describe, it} from 'node:test'

import {readSession} from '../../src/core/session.ts'
import {SESSION_FIXTURES} from '../helpers/sessions.ts'

const names = (turn: {actions: Array<{name: string}>}) => turn.actions.map((a) => a.name)

// What the real Customer Service Agent did before it was fixed. These are the faults the stamp has to catch.
describe('the faults visible in real preview traces', () => {
  it('simulated preview: the unfilled merge field shows up in the create_case input', () => {
    const s = readSession(join(SESSION_FIXTURES, 'simulated'))
    assert.equal(s.mode, 'Mock')
    assert.equal(s.turns.length, 2)
    const [refund, followUp] = s.turns
    assert.equal(refund.traceStatus, 'ok')
    assert.equal(refund.utterance, 'I was charged twice for my last order and I want a refund')
    assert.equal(refund.topic, 'resolution')
    assert.deepEqual(refund.transitions, ['triage', 'resolution'])
    assert.deepEqual(names(refund), ['classify_issue', 'search_knowledge_base', 'create_case'])
    const create = refund.actions.find((a) => a.name === 'create_case')
    assert.match(JSON.stringify(create?.input), /\{!state\.issue_type\}/)
    assert.equal(followUp.traceStatus, 'ok')
    assert.deepEqual(names(followUp), [])
  })

  it('live preview: the agent escalates without ever creating a case', () => {
    const s = readSession(join(SESSION_FIXTURES, 'bundle-live'))
    assert.equal(s.mode, 'Live Test')
    assert.equal(s.agentId, 'CustomerServiceAgent')
    const [refund, followUp] = s.turns
    assert.equal(refund.topic, 'resolution')
    assert.deepEqual(names(refund), ['classify_issue', 'search_knowledge_base', 'escalate_case'])
    assert.ok(!names(refund).includes('create_case'))
    const escalate = refund.actions.find((a) => a.name === 'escalate_case')
    assert.equal((escalate?.input as {case_id?: string}).case_id, '', 'escalate_case gets an empty case_id')
    assert.ok(refund.actions.every((a) => typeof a.latencyMs === 'number'))
    assert.deepEqual(names(followUp), [])
  })

  it('published agent: every trace is empty, and the reader reports that instead of guessing', () => {
    const s = readSession(join(SESSION_FIXTURES, 'published-agent'))
    assert.equal(s.mode, undefined)
    assert.equal(s.turns.length, 2)
    assert.ok(s.turns.every((t) => t.traceStatus === 'empty' && t.actions.length === 0 && t.topic === undefined))
  })
})
