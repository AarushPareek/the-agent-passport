import assert from 'node:assert/strict'
import {join} from 'node:path'
import {describe, it} from 'node:test'

import {listSessions, readSession} from '../../src/core/session.ts'
import {tempProject} from '../helpers/fixtures.ts'
import {copySession, SESSION_FIXTURES, writeSession} from '../helpers/sessions.ts'

describe('readSession on real sf agent preview sessions', () => {
  it('live authoring-bundle preview: utterances, full replies, routing and real actions', () => {
    const s = readSession(join(SESSION_FIXTURES, 'bundle-live'))
    assert.equal(s.mode, 'Live Test')
    assert.equal(s.agentId, 'CustomerServiceAgent')
    assert.equal(s.turns.length, 2)
    const [refund, createCase] = s.turns
    assert.equal(refund.utterance, 'I was charged twice for my last order and I want a refund')
    assert.match(refund.reply ?? '', /escalated your case to a specialist/)
    assert.equal(refund.traceStatus, 'ok')
    assert.equal(refund.topic, 'resolution')
    assert.deepEqual(refund.transitions, ['triage', 'resolution'])
    assert.deepEqual(
      refund.actions.map((a) => a.name),
      ['classify_issue', 'search_knowledge_base', 'escalate_case'],
    )
    assert.equal(createCase.utterance, 'Please create a case for this')
    assert.match(createCase.reply ?? '', /A case is being created/)
    assert.deepEqual(createCase.actions, [])
  })

  it('simulated preview is marked Mock', () => {
    assert.equal(readSession(join(SESSION_FIXTURES, 'simulated')).mode, 'Mock')
  })

  it('published-agent preview: replies are there, but traces are empty and say so', () => {
    const s = readSession(join(SESSION_FIXTURES, 'published-agent'))
    assert.equal(s.mode, undefined)
    assert.equal(s.turns.length, 2)
    assert.ok(s.turns.every((t) => t.traceStatus === 'empty' && t.reply))
  })
})

describe('listSessions', () => {
  it('lists an agent\'s saved sessions oldest first, and ignores other agents', () => {
    const p = tempProject('agent-script-recipes')
    try {
      copySession(p.root, 'bundle-live', 'CustomerServiceAgent', 's-2', '2026-10-23T10:02:00.000Z')
      copySession(p.root, 'bundle-live', 'CustomerServiceAgent', 's-1', '2026-10-23T10:01:00.000Z')
      writeSession(p.root, 'HelloWorld', 'other', '2026-10-23T10:00:00.000Z', [{reply: 'hi', utterance: 'hello'}])
      assert.deepEqual(
        listSessions(p.root, 'CustomerServiceAgent').map((s) => s.sessionId),
        ['s-1', 's-2'],
      )
      assert.deepEqual(listSessions(p.root, 'Nobody'), [])
    } finally {
      p.cleanup()
    }
  })
})
