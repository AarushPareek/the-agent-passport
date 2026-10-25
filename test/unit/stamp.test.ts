import assert from 'node:assert/strict'
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, it} from 'node:test'

import type {GoldenSuite} from '../../src/core/goldens.ts'
import {saveSuite} from '../../src/core/goldens.ts'
import type {SessionTurn} from '../../src/core/session.ts'
import {baselinePath, checkTurn, runStamp, runVerify} from '../../src/core/stamp.ts'
import {runTravel} from '../../src/core/travel.ts'
import type {Stamp} from '../../src/core/stamp.ts'
import {CSA_AGENT_FILE, tempProject} from '../helpers/fixtures.ts'
import {gitProject} from '../helpers/git-fixture.ts'
import {copySession, writeSession} from '../helpers/sessions.ts'
import type {FakeTurn} from '../helpers/sessions.ts'

const AGENT = 'CustomerServiceAgent'
const REFUND = 'I was charged twice for my last order and I want a refund'

/** A copy of the real Customer Service Agent with the setup fix applied (developer_name matches the folder). */
function project() {
  const p = tempProject('agent-script-recipes')
  p.edit(CSA_AGENT_FILE, (t) => t.replace('developer_name: "CustomerService_Agent"', `developer_name: "${AGENT}"`))
  return p
}

function suite(overrides: Partial<GoldenSuite> = {}): GoldenSuite {
  return {
    agent: AGENT,
    bundle: AGENT,
    conversations: [
      {criterion: 'A refund request routes to the resolution subagent.', id: 'AC-1', turns: [{expect: {inputsResolved: true, topic: 'resolution'}, utterance: REFUND}]},
      {criterion: 'The agent creates a real case and tells the customer the case number.', id: 'AC-2', turns: [{expect: {actionsInclude: ['create_case'], inputsResolved: true}, utterance: REFUND}]},
    ],
    passThreshold: 1,
    runsPerConversation: 3,
    schemaVersion: 1,
    ...overrides,
  }
}

const good: FakeTurn = {actions: [{input: {issueDescription: 'double charge'}, name: 'classify_issue'}, {input: {subject: 'billing: double charge'}, name: 'create_case'}], reply: 'I created case 00001042 for you.', topic: 'resolution', transitions: ['triage', 'resolution'], utterance: REFUND}
const noCase: FakeTurn = {...good, actions: [{input: {case_id: '', reason: 'billing'}, name: 'escalate_case'}], reply: 'A case is being created.'}

const runs = (root: string, turn: FakeTurn, count: number, from = 0, mode = 'Live Test') => {
  for (let i = 0; i < count; i++) writeSession(root, AGENT, `run-${from + i}`, `2026-10-23T10:${String(from + i).padStart(2, '0')}:00.000Z`, [turn], mode)
}
const readStamp = (root: string, env = 'Passport-Dev'): Stamp => JSON.parse(readFileSync(join(root, 'passport', 'stamps', env, `${AGENT}.json`), 'utf8'))

describe('checkTurn', () => {
  const turn: SessionTurn = {actions: [{input: {subject: '{!state.issue_type}: x'}, name: 'create_case', output: {}}], reply: 'Your case number is 00001042.', topic: 'resolution', traceStatus: 'ok', transitions: ['triage', 'resolution'], utterance: REFUND}

  it('checks topic against the whole route, actions, excluded actions and replies', () => {
    const checks = checkTurn(turn, {expect: {actionsExclude: ['escalate_case'], actionsInclude: ['create_case'], inputsResolved: false, replyMatches: 'case number is \\d{8}', replyNotMatches: 'sorry', topic: 'triage'}, utterance: REFUND}, 0)
    assert.deepEqual(
      checks.map((c) => [c.name, c.passed]),
      [
        ['topic', true],
        ['action', true],
        ['action-excluded', true],
        ['reply', true],
        ['reply-excluded', true],
      ],
    )
  })

  it('fails an unfilled merge field in an action input by default, naming it', () => {
    const [check] = checkTurn(turn, {expect: {}, utterance: REFUND}, 0)
    assert.equal(check.passed, false)
    assert.match(check.detail, /create_case \(\{!state\.issue_type\}\)/)
  })

  it('fails clearly when the trace is empty (published-agent previews)', () => {
    const [check] = checkTurn({...turn, traceStatus: 'empty'}, {expect: {topic: 'resolution'}, utterance: REFUND}, 0)
    assert.equal(check.name, 'trace')
    assert.match(check.detail, /--authoring-bundle/)
  })
})

describe('stamp', () => {
  it('grants the stamp when every conversation passes every run, and writes a first baseline', () => {
    const p = project()
    try {
      saveSuite(p.root, suite())
      runs(p.root, good, 3)
      const out = runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev', now: new Date('2026-10-23T11:00:00Z')})
      assert.equal(out.stamp.verdict, 'stamped')
      assert.equal(out.stamp.mode, 'live')
      assert.deepEqual(out.stamp.goldens.map((g) => [g.id, g.runs.length, g.passRate]), [
        ['AC-1', 3, 1],
        ['AC-2', 3, 1],
      ])
      assert.match(out.stamp.fingerprint, /^sha256:[0-9a-f]{64}$/)
      assert.ok(out.baselineWritten && existsSync(out.baselineWritten))
      assert.deepEqual(readStamp(p.root).stampedAt, '2026-10-23T11:00:00.000Z')
    } finally {
      p.cleanup()
    }
  })

  it('refuses the stamp on the REAL live trace: the agent said a case was being created but never ran create_case', () => {
    const p = project()
    try {
      saveSuite(p.root, suite())
      for (let i = 0; i < 3; i++) copySession(p.root, 'bundle-live', AGENT, `live-${i}`, `2026-10-23T09:0${i}:00.000Z`)
      const {stamp} = runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'})
      assert.equal(stamp.verdict, 'refused')
      const [ac1, ac2] = stamp.goldens
      assert.equal(ac1.passed, false)
      assert.ok(ac1.runs[0].checks.some((c) => c.name === 'topic' && c.passed), 'routing to resolution itself was right')
      assert.ok(ac1.runs[0].checks.some((c) => c.name === 'inputs-resolved' && !c.passed && /escalate_case/.test(c.detail)))
      assert.match(ac2.runs[0].checks.find((c) => c.name === 'action')!.detail, /expected action "create_case" to run; ran classify_issue, search_knowledge_base, escalate_case/)
    } finally {
      p.cleanup()
    }
  })

  it('refuses when there are fewer runs than required, and says how many', () => {
    const p = project()
    try {
      saveSuite(p.root, suite())
      runs(p.root, good, 2)
      const {stamp} = runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'})
      assert.equal(stamp.verdict, 'refused')
      assert.ok(stamp.problems.includes('AC-1: 2 of 3 runs found. Run `agentia passport goldens plan` and execute the missing runs.'))
    } finally {
      p.cleanup()
    }
  })

  it('applies the pass threshold to repeated runs (LLM variability)', () => {
    const p = project()
    try {
      runs(p.root, good, 2)
      runs(p.root, noCase, 1, 2)
      saveSuite(p.root, suite())
      assert.equal(runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'}).stamp.verdict, 'refused', '2 of 3 is not enough at 100%')
      saveSuite(p.root, suite({passThreshold: 0.66}))
      const {stamp} = runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'})
      assert.equal(stamp.verdict, 'stamped', '2 of 3 passes a 66% threshold')
      assert.equal(Math.round(stamp.goldens[1].passRate * 100), 67)
    } finally {
      p.cleanup()
    }
  })

  it('scores only the latest runs, and --since ignores older sessions', () => {
    const p = project()
    try {
      saveSuite(p.root, suite())
      runs(p.root, noCase, 3, 0)
      runs(p.root, good, 3, 10)
      assert.equal(runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'}).stamp.verdict, 'stamped')
      const sinceLater = runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev', since: '2026-10-23T10:11:00.000Z'}).stamp
      assert.equal(sinceLater.goldens[0].runs.length, 2)
      assert.equal(sinceLater.verdict, 'refused')
    } finally {
      p.cleanup()
    }
  })

  it('marks a stamp from simulated actions as simulated', () => {
    const p = project()
    try {
      saveSuite(p.root, suite())
      runs(p.root, good, 3, 0, 'Mock')
      assert.equal(runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'}).stamp.mode, 'simulated')
    } finally {
      p.cleanup()
    }
  })

  it('flags a regression when a conversation that passed in the baseline now fails', () => {
    const p = project()
    try {
      saveSuite(p.root, suite())
      runs(p.root, good, 3)
      runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'})
      runs(p.root, noCase, 3, 10)
      const {stamp} = runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'})
      assert.equal(stamp.verdict, 'refused')
      assert.equal(stamp.goldens[1].regression, 'was-passing')
      const baseline = JSON.parse(readFileSync(join(p.root, baselinePath(AGENT)), 'utf8'))
      assert.equal(baseline.conversations['AC-2'].passed, true, 'a refused stamp never overwrites the good baseline')
    } finally {
      p.cleanup()
    }
  })

  it('notices when a passing conversation took a different route than the baseline', () => {
    const p = project()
    try {
      saveSuite(p.root, suite())
      runs(p.root, good, 3)
      runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'})
      runs(p.root, {...good, transitions: ['resolution']}, 3, 10)
      const {stamp} = runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'})
      assert.equal(stamp.verdict, 'stamped')
      assert.equal(stamp.goldens[0].regression, 'route-changed')
    } finally {
      p.cleanup()
    }
  })

  it('refuses a suite whose utterances are not written yet', () => {
    const p = project()
    try {
      const s = suite()
      s.conversations[0].turns[0].utterance = null
      saveSuite(p.root, s)
      runs(p.root, good, 3)
      const {stamp} = runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'})
      assert.equal(stamp.verdict, 'refused')
      assert.ok(stamp.problems.includes('AC-1 turn 1: utterance is not written yet.'))
    } finally {
      p.cleanup()
    }
  })
})

describe('verify (the gate)', () => {
  const stamped = () => {
    const p = project()
    saveSuite(p.root, suite())
    runs(p.root, good, 3)
    runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'})
    return p
  }
  const result = (root: string, options: Partial<Parameters<typeof runVerify>[1]> = {}) => runVerify(root, {agent: AGENT, environment: 'Passport-Dev', ...options})[0]

  it('passes with a granted, current stamp and no scan errors', () => {
    const p = stamped()
    try {
      const r = result(p.root)
      assert.equal(r.passed, true, JSON.stringify(r.checks))
      assert.deepEqual(r.checks.map((c) => c.name), ['scan', 'stamp'])
    } finally {
      p.cleanup()
    }
  })

  it('fails without a stamp for that environment', () => {
    const p = stamped()
    try {
      const r = result(p.root, {environment: 'Passport-QA'})
      assert.equal(r.passed, false)
      assert.match(r.checks[1].detail, /no Passport-QA stamp/)
    } finally {
      p.cleanup()
    }
  })

  it('fails when the agent changed after it was stamped (stale stamp)', () => {
    const p = stamped()
    try {
      p.edit(CSA_AGENT_FILE, (t) => t.replace('Customer service agent that classifies', 'Customer service agent that triages'))
      const r = result(p.root)
      assert.equal(r.passed, false)
      assert.match(r.checks[1].detail, /stamp is stale: the agent or one of its dependencies changed/)
    } finally {
      p.cleanup()
    }
  })

  it('fails when a dependency (a Flow) changed after stamping', () => {
    const p = stamped()
    try {
      p.edit('force-app-service/customerServiceAgent/flows/CreateCase.flow-meta.xml', (t) => t.replace('</Flow>', '<!-- changed --></Flow>'))
      assert.equal(result(p.root).passed, false)
    } finally {
      p.cleanup()
    }
  })

  it('fails when the golden conversations were edited after stamping', () => {
    const p = stamped()
    try {
      const s = suite()
      s.conversations.pop()
      saveSuite(p.root, s)
      const r = result(p.root)
      assert.equal(r.passed, false)
      assert.match(r.checks[1].detail, /golden conversations changed/)
    } finally {
      p.cleanup()
    }
  })

  it('ignores Windows line endings when comparing fingerprints', () => {
    const p = stamped()
    try {
      p.edit(CSA_AGENT_FILE, (t) => t.replace(/\n/g, '\r\n'))
      assert.equal(result(p.root).passed, true)
    } finally {
      p.cleanup()
    }
  })

  it('fails when the stamp was refused, and lists the failing conversations', () => {
    const p = project()
    try {
      saveSuite(p.root, suite())
      runs(p.root, noCase, 3)
      runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'})
      const r = result(p.root)
      assert.equal(r.passed, false)
      assert.match(r.checks[1].detail, /stamp was refused: AC-2 \(0%\)/)
    } finally {
      p.cleanup()
    }
  })

  it('fails on scan errors even with a good stamp (the original sample has NAME_MISMATCH)', () => {
    const p = stamped()
    try {
      p.edit(CSA_AGENT_FILE, (t) => t.replace(`developer_name: "${AGENT}"`, 'developer_name: "CustomerService_Agent"'))
      const r = runVerify(p.root, {agent: AGENT, environment: 'Passport-Dev'})[0]
      assert.equal(r.checks[0].passed, false)
      assert.match(r.checks[0].detail, /NAME_MISMATCH/)
    } finally {
      p.cleanup()
    }
  })

  it('with --require-live, rejects a simulated stamp', () => {
    const p = project()
    try {
      saveSuite(p.root, suite())
      runs(p.root, good, 3, 0, 'Mock')
      runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'})
      assert.equal(result(p.root).passed, true)
      assert.equal(result(p.root, {requireLive: true}).passed, false)
    } finally {
      p.cleanup()
    }
  })

  it('with --travel, also requires a travel result without gaps', () => {
    const p = stamped()
    try {
      const travel = (gap: boolean) => writeFileSync(join(p.root, 'passport', 'travel-Passport-QA.json'), JSON.stringify({agents: [{agent: AGENT, items: [{component: 'Flow:EscalateCase', status: gap ? 'gap' : 'in-story'}], ok: !gap}]}))
      travel(false)
      assert.equal(result(p.root, {travelFile: 'passport/travel-Passport-QA.json'}).passed, true)
      travel(true)
      const r = result(p.root, {travelFile: 'passport/travel-Passport-QA.json'})
      assert.equal(r.passed, false)
      assert.match(r.checks.find((c) => c.name === 'travel')!.detail, /Flow:EscalateCase/)
      assert.equal(result(p.root, {travelFile: 'passport/missing.json'}).passed, false)
    } finally {
      p.cleanup()
    }
  })

  it('with a travel result computed now (the gate), fails until the forgotten Flow is committed to the story', () => {
    const p = gitProject('agent-script-recipes')
    try {
      p.edit(CSA_AGENT_FILE, (t) => t.replace('developer_name: "CustomerService_Agent"', `developer_name: "${AGENT}"`))
      saveSuite(p.root, suite())
      runs(p.root, good, 3)
      runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'})
      p.git('checkout', '-qb', 'feature/US-0000025')
      p.git('add', 'sfdx-project.json', 'force-app', 'force-app-service')
      p.git('reset', '-q', '--', 'force-app-service/customerServiceAgent/flows/EscalateCase.flow-meta.xml')
      p.git('commit', '-qm', 'story that forgot EscalateCase')
      const travelNow = () => runTravel(p.root, {agent: AGENT, targetBranch: 'main', targetEnvironment: 'Passport-QA'})

      const blocked = result(p.root, {travel: travelNow()})
      assert.equal(blocked.passed, false)
      assert.equal(blocked.checks.find((c) => c.name === 'stamp')!.passed, true, 'the stamp itself is fine; travel is what fails')
      assert.equal(blocked.checks.find((c) => c.name === 'travel')!.detail, 'will not arrive in Passport-QA: Flow:EscalateCase')

      p.commit('add the Flow', 'force-app-service/customerServiceAgent/flows/EscalateCase.flow-meta.xml')
      const ok = result(p.root, {travel: travelNow()})
      assert.equal(ok.passed, true, JSON.stringify(ok.checks))
      assert.equal(ok.checks.find((c) => c.name === 'travel')!.detail, 'no travel gaps to Passport-QA')
    } finally {
      p.cleanup()
    }
  })
})
