import assert from 'node:assert/strict'
import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, it} from 'node:test'

import type {GoldenSuite} from '../../src/core/goldens.ts'
import {saveSuite} from '../../src/core/goldens.ts'
import {buildReport, esc, renderReport, writeReport} from '../../src/core/report.ts'
import {runStamp} from '../../src/core/stamp.ts'
import {runTravel} from '../../src/core/travel.ts'
import {CSA_AGENT_FILE, tempProject} from '../helpers/fixtures.ts'
import {gitProject} from '../helpers/git-fixture.ts'
import {copySession, writeSession} from '../helpers/sessions.ts'
import type {FakeTurn} from '../helpers/sessions.ts'

const AGENT = 'CustomerServiceAgent'
const REFUND = 'I was charged twice for my last order and I want a refund'
const NOW = new Date('2026-10-23T12:30:00Z')

const suite = (utterance = REFUND, runs = 2): GoldenSuite => ({
  agent: AGENT,
  bundle: AGENT,
  conversations: [
    {criterion: 'A refund request routes to the resolution subagent.', id: 'AC-1', turns: [{expect: {inputsResolved: true, topic: 'resolution'}, utterance}]},
    {criterion: 'The agent creates a real case and tells the customer the case number.', id: 'AC-2', turns: [{expect: {actionsInclude: ['create_case'], inputsResolved: true}, utterance}]},
  ],
  passThreshold: 1,
  runsPerConversation: runs,
  schemaVersion: 1,
})
const good = (utterance = REFUND, reply = 'I created case 00001042 for you.'): FakeTurn => ({actions: [{input: {subject: 'double charge'}, name: 'create_case'}], reply, topic: 'resolution', transitions: ['triage', 'resolution'], utterance})

function project() {
  const p = tempProject('agent-script-recipes')
  p.edit(CSA_AGENT_FILE, (t) => t.replace('developer_name: "CustomerService_Agent"', `developer_name: "${AGENT}"`))
  return p
}
const report = (root: string, environment = 'Passport-Dev') => renderReport(buildReport(root, {agent: AGENT, environment, now: NOW}))

describe('passport report', () => {
  it('shows a valid passport: verdict, stamp, both conversations, the dependency map and the evidence hashes', () => {
    const p = project()
    try {
      saveSuite(p.root, suite())
      for (const i of [1, 2]) writeSession(p.root, AGENT, `ok-${i}`, `2026-10-23T11:0${i}:00.000Z`, [good()])
      runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'})
      const data = buildReport(p.root, {agent: AGENT, environment: 'Passport-Dev', now: NOW})
      assert.equal(data.valid, true)
      const html = renderReport(data)
      assert.match(html, /<div class="verdict">VALID<small>for Passport-Dev<\/small><\/div>/)
      assert.match(html, /STAMPED/)
      assert.match(html, /AC-1<\/b> A refund request routes to the resolution subagent\./)
      assert.match(html, /100% of 2\/2 runs/)
      assert.match(html, /I created case 00001042 for you\./, 'the transcript is in the report')
      assert.match(html, /<span class="type">Flow<\/span> EscalateCase/, 'dependency map')
      assert.match(html, /2 of 2 scored session\(s\) are in this checkout/, 'counts sessions once, though both conversations used them')
      assert.match(html, /agent fingerprint <code>[0-9a-f]{12}<\/code>/)
    } finally {
      p.cleanup()
    }
  })

  it('shows a refused passport with the real Dev-org failures, and marks turns the stamp did not score', () => {
    const p = project()
    try {
      saveSuite(p.root, suite(REFUND, 1))
      copySession(p.root, 'bundle-live', AGENT, 'real-1', '2026-10-23T09:00:00.000Z')
      runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'})
      const html = report(p.root)
      assert.match(html, /NOT VALID/)
      assert.match(html, /REFUSED/)
      assert.match(html, /unfilled merge field in the input of escalate_case \(\{!state\.issue_type\}\)/)
      assert.match(html, /expected action &quot;create_case&quot; to run/)
      assert.match(html, /Not part of this golden conversation \(not scored\)/)
    } finally {
      p.cleanup()
    }
  })

  it('shows every environment stamp, the report\'s environment first, and marks a stamp stale after the agent changes', () => {
    const p = project()
    try {
      saveSuite(p.root, suite())
      for (const i of [1, 2]) writeSession(p.root, AGENT, `ok-${i}`, `2026-10-23T11:0${i}:00.000Z`, [good()])
      runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'})
      runStamp(p.root, {agent: AGENT, environment: 'Passport-QA'})
      p.edit(CSA_AGENT_FILE, (t) => `${t}\n# changed\n`)
      const data = buildReport(p.root, {agent: AGENT, environment: 'Passport-QA', now: NOW})
      assert.deepEqual(data.agents[0].stamps.map((s) => [s.environment, s.valid]), [['Passport-QA', false], ['Passport-Dev', false]])
      const html = renderReport(data)
      assert.equal(html.match(/STALE/g)?.length, 2)
      assert.match(html, /stamp is stale: the agent or one of its dependencies changed/)
    } finally {
      p.cleanup()
    }
  })

  it('includes travel and the deployment steps when given, and says when travel was not checked', () => {
    const p = gitProject('agent-script-recipes')
    try {
      p.edit(CSA_AGENT_FILE, (t) => t.replace('developer_name: "CustomerService_Agent"', `developer_name: "${AGENT}"`))
      p.git('checkout', '-qb', 'feature/US-0000025')
      p.git('add', 'sfdx-project.json', 'force-app', 'force-app-service')
      p.git('reset', '-q', '--', 'force-app-service/customerServiceAgent/flows/EscalateCase.flow-meta.xml')
      p.git('commit', '-qm', 'story')
      const travel = runTravel(p.root, {agent: AGENT, targetBranch: 'main', targetEnvironment: 'Passport-QA'})
      const data = buildReport(p.root, {agent: AGENT, environment: 'Passport-Dev', now: NOW, travel})
      assert.equal(data.branch, 'feature/US-0000025')
      const html = renderReport(data)
      assert.match(html, /<h2>Travel to Passport-QA<\/h2>/)
      assert.match(html, /<tr class="gap"><td>Flow:EscalateCase<\/td><td><span class="tag bad">will not arrive<\/span>/)
      assert.match(html, /Publish and activate CustomerServiceAgent in Passport-QA/)
      assert.match(html, /will not arrive in Passport-QA: Flow:EscalateCase/, 'the gate check line')
      assert.match(report(p.root), /Not checked for this report/)
    } finally {
      p.cleanup()
    }
  })

  it('escapes everything that comes from a chat or a file, so a reply cannot inject HTML or script', () => {
    const p = project()
    try {
      const hostile = '<script>alert("x")</script><img src=x onerror=alert(1)>'
      saveSuite(p.root, suite(hostile))
      for (const i of [1, 2]) writeSession(p.root, AGENT, `ok-${i}`, `2026-10-23T11:0${i}:00.000Z`, [good(hostile, `Sure ${hostile} & done`)])
      runStamp(p.root, {agent: AGENT, environment: 'Passport-Dev'})
      const html = report(p.root)
      assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'))
      assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'shown as text')
      // No live tag: the only "<img" or "<script" would be one the browser runs. Escaped text like "onerror=alert" is inert.
      assert.doesNotMatch(html, /<script|<img/i)
    } finally {
      p.cleanup()
    }
  })

  it('is one self-contained file: no scripts, no external links, fonts or images', () => {
    const p = project()
    try {
      const html = report(p.root)
      assert.match(html, /^<!doctype html>/)
      assert.doesNotMatch(html, /<script|<link|<img|@import|url\(|https?:\/\//i)
      assert.match(html, /prefers-color-scheme:dark/)
      assert.match(html, /No stamp for this environment yet/)
    } finally {
      p.cleanup()
    }
  })

  it('is the same bytes for the same inputs and time, and writes to passport/report.html', () => {
    const p = project()
    try {
      assert.equal(report(p.root), report(p.root))
      const file = writeReport(p.root, report(p.root))
      assert.equal(file, join(p.root, 'passport', 'report.html'))
      assert.ok(existsSync(file))
      assert.equal(readFileSync(file, 'utf8'), report(p.root))
    } finally {
      p.cleanup()
    }
  })

  it('esc covers the five HTML special characters', () => {
    assert.equal(esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
    assert.equal(esc(undefined), '')
  })
})
