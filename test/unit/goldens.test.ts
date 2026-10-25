import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {draftSuite, expectationFor, runPlan, splitCriteria, stem, validateSuite, vocabulary} from '../../src/core/goldens.ts'
import type {GoldenSuite} from '../../src/core/goldens.ts'
import {runScan} from '../../src/core/scan.ts'
import {fixtureProject} from '../helpers/fixtures.ts'

const csa = runScan(fixtureProject('agent-script-recipes'), {agent: 'CustomerServiceAgent'}).agents[0]
const coral = runScan(fixtureProject('coral-cloud'), {agent: 'Coral_Cloud_Agent'}).agents[0]
// The real acceptance criteria of story US-0000025, exactly as Copado returns them (one line).
const US_25_CRITERIA = 'A refund request routes to the resolution subagent. The agent creates a real case and tells the customer the case number.'

describe('splitCriteria', () => {
  it('splits a one-line criteria field into sentences (the way Copado returns the field)', () => {
    assert.deepEqual(splitCriteria(US_25_CRITERIA), ['A refund request routes to the resolution subagent.', 'The agent creates a real case and tells the customer the case number.'])
  })

  it('splits lines, bullets, numbering and semicolons, and drops empty parts', () => {
    assert.deepEqual(splitCriteria('- Billing questions route to triage\n2) Never escalate a password reset; Always greet the customer\n\n'), [
      'Billing questions route to triage',
      'Never escalate a password reset',
      'Always greet the customer',
    ])
  })

  it('does not split inside a version number or decimal', () => {
    assert.deepEqual(splitCriteria('Refunds above 1.5 times the order value escalate.'), ['Refunds above 1.5 times the order value escalate.'])
  })
})

describe('stem', () => {
  it('gives word forms a shared base', () => {
    for (const [a, b] of [['creates', 'create'], ['creating', 'create'], ['cases', 'case'], ['classifies', 'classify'], ['routes', 'route']]) assert.equal(stem(a), stem(b), `${a} ~ ${b}`)
    assert.notEqual(stem('case'), stem('create'))
  })
})

describe('expectationFor (matching criteria to the real agent)', () => {
  it('knows the Customer Service Agent\'s subagents and actions', () => {
    assert.deepEqual(vocabulary(csa).topics.sort(), ['resolution', 'triage'], 'the start_agent router is not a test target')
    assert.deepEqual(vocabulary(csa).actions.sort(), ['classify_issue', 'create_case', 'escalate_case', 'fetch_customer', 'search_knowledge_base'])
  })

  it('maps "routes to the resolution subagent" to a topic expectation', () => {
    assert.deepEqual(expectationFor('A refund request routes to the resolution subagent.', csa), {expect: {inputsResolved: true, topic: 'resolution'}, matched: true})
  })

  it('maps "creates a real case" to the create_case action', () => {
    assert.deepEqual(expectationFor('The agent creates a real case and tells the customer the case number.', csa).expect.actionsInclude, ['create_case'])
  })

  it('turns a negative criterion into an excluded action', () => {
    assert.deepEqual(expectationFor('A simple question must not escalate the case.', csa).expect, {actionsExclude: ['escalate_case'], inputsResolved: true})
  })

  it('reports an unmatched criterion instead of guessing', () => {
    assert.deepEqual(expectationFor('The tone is friendly.', csa), {expect: {inputsResolved: true}, matched: false})
  })

  it('uses topics and actions for classic agents', () => {
    assert.ok(vocabulary(coral).topics.includes('Verified_Customer_Support'))
    assert.deepEqual(expectationFor('Weather questions go to Verified Customer Support and check the weather.', coral).expect, {
      actionsInclude: ['Check_Weather'],
      inputsResolved: true,
      topic: 'Verified_Customer_Support',
    })
  })
})

describe('draftSuite and validateSuite', () => {
  it('drafts one conversation per criterion from the real US-0000025 story', () => {
    const suite = draftSuite(csa, splitCriteria(US_25_CRITERIA), {story: 'US-0000025'})
    assert.equal(suite.agent, 'CustomerService_Agent')
    assert.equal(suite.bundle, 'CustomerServiceAgent')
    assert.deepEqual(suite.conversations.map((c) => [c.id, c.story, c.turns[0].utterance]), [
      ['AC-1', 'US-0000025', null],
      ['AC-2', 'US-0000025', null],
    ])
    assert.equal(suite.runsPerConversation, 3)
    assert.equal(suite.passThreshold, 1)
  })

  it('without criteria, drafts one route test per subagent', () => {
    assert.deepEqual(draftSuite(csa, []).conversations.map((c) => c.id).sort(), ['ROUTE-resolution', 'ROUTE-triage'])
  })

  it('refuses to run until utterances are written, and checks names against the agent', () => {
    const suite = draftSuite(csa, splitCriteria(US_25_CRITERIA))
    assert.deepEqual(validateSuite(suite, csa), ['AC-1 turn 1: utterance is not written yet.', 'AC-2 turn 1: utterance is not written yet.'])
    for (const c of suite.conversations) c.turns[0].utterance = 'I was charged twice and want a refund'
    assert.deepEqual(validateSuite(suite, csa), [])
    suite.conversations[0].turns[0].expect.topic = 'billing_desk'
    suite.conversations[1].turns[0].expect.actionsInclude = ['refund_payment']
    suite.conversations[1].turns[0].expect.replyMatches = '(unclosed'
    assert.deepEqual(validateSuite(suite, csa), [
      'AC-1 turn 1: the agent has no subagent or topic "billing_desk" (has: resolution, triage).',
      'AC-2 turn 1: "(unclosed" is not a valid regular expression.',
      'AC-2 turn 1: the agent has no action "refund_payment".',
    ])
  })

  it('rejects bad settings', () => {
    const suite = {...draftSuite(csa, ['x routes to triage']), passThreshold: 0, runsPerConversation: 0} as GoldenSuite
    const problems = validateSuite(suite)
    assert.ok(problems.includes('runsPerConversation must be a whole number of at least 1.'))
    assert.ok(problems.includes('passThreshold must be more than 0 and at most 1.'))
  })
})

describe('runPlan', () => {
  it('prints start, send per turn, end, for every run, with live actions by default', () => {
    const suite = draftSuite(csa, ['A refund request routes to the resolution subagent.'], {runs: 2})
    suite.conversations[0].turns[0].utterance = 'I was charged "twice" and want a refund'
    const plan = runPlan(suite, 'passport-dev')
    assert.equal(plan.length, 2)
    assert.deepEqual(plan[0].commands, [
      'sf agent preview start --authoring-bundle CustomerServiceAgent --use-live-actions --target-org passport-dev --json',
      `sf agent preview send --authoring-bundle CustomerServiceAgent --target-org passport-dev --utterance "I was charged 'twice' and want a refund" --json`,
      'sf agent preview end --authoring-bundle CustomerServiceAgent --target-org passport-dev --json',
    ])
    assert.match(runPlan(suite, 'passport-dev', {simulate: true})[0].commands[0], /--simulate-actions/)
  })
})
