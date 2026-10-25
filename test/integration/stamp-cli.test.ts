import assert from 'node:assert/strict'
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {after, before, describe, it} from 'node:test'

import type {GoldenSuite} from '../../src/core/goldens.ts'
import {AGENTIA_BIN, agentia, parseEnvelope} from '../helpers/agentia-cli.ts'
import {CSA_AGENT_FILE, tempProject} from '../helpers/fixtures.ts'
import {copySession, writeSession} from '../helpers/sessions.ts'

const AGENT = 'CustomerServiceAgent'
const REFUND = 'I was charged twice for my last order and I want a refund'
// The real acceptance criteria of story US-0000025, exactly as Copado returns them (one line).
const US_25_CRITERIA = 'A refund request routes to the resolution subagent. The agent creates a real case and tells the customer the case number.'

// Precondition (checked, not assumed): the plugin is built and linked into the real CLI:
//   npm run build && agentia plugins link .
describe('goldens, stamp and verify inside the real Agentia CLI', () => {
  const p = tempProject('agent-script-recipes')
  const goldens = join(p.root, 'passport', 'goldens', `${AGENT}.json`)
  const d = ['--project-dir', p.root]

  before(async () => {
    const plugins = await agentia(['plugins'])
    assert.equal(plugins.code, 0, `Could not run "${AGENTIA_BIN} plugins": ${plugins.stderr}`)
    assert.match(plugins.stdout, /agentia-plugin-passport/, 'Plugin is not linked. Run: npm run build && agentia plugins link .')
    // The setup fix every real project needs: developer_name matches the bundle folder (scan reports NAME_MISMATCH otherwise).
    p.edit(CSA_AGENT_FILE, (t) => t.replace('developer_name: "CustomerService_Agent"', `developer_name: "${AGENT}"`))
  })
  after(() => p.cleanup())

  it('goldens init drafts one conversation per acceptance criterion', async () => {
    const out = await agentia(['passport', 'goldens', 'init', '--agent', AGENT, '--criteria', US_25_CRITERIA, '--runs', '2', ...d, '--json'])
    assert.doesNotMatch(out.stdout + out.stderr, /update the CLI/i, 'The CLI is missing a host method listed in agentia.requires')
    assert.equal(out.code, 0, out.stdout + out.stderr)
    const suite = JSON.parse(readFileSync(goldens, 'utf8')) as GoldenSuite
    assert.deepEqual(suite.conversations.map((c) => [c.id, c.turns[0].expect.topic, c.turns[0].expect.actionsInclude]), [
      ['AC-1', 'resolution', undefined],
      ['AC-2', undefined, ['create_case']],
    ])
    const again = await agentia(['passport', 'goldens', 'init', '--agent', AGENT, '--criteria', US_25_CRITERIA, ...d])
    assert.notEqual(again.code, 0, 'must not overwrite reviewed goldens without --force')
  })

  it('goldens plan refuses until utterances are written, then prints every preview command', async () => {
    const refused = await agentia(['passport', 'goldens', 'plan', '--agent', AGENT, '--target-org', 'passport-dev', ...d])
    assert.notEqual(refused.code, 0)
    assert.match(refused.stdout + refused.stderr, /utterance is not written yet/)

    const suite = JSON.parse(readFileSync(goldens, 'utf8')) as GoldenSuite
    for (const c of suite.conversations) c.turns[0].utterance = REFUND
    writeFileSync(goldens, JSON.stringify(suite, null, 2))
    const out = await agentia(['passport', 'goldens', 'plan', '--agent', AGENT, '--target-org', 'passport-dev', ...d, '--json'])
    assert.equal(out.code, 0, out.stdout + out.stderr)
    const plan = parseEnvelope(out.stdout).result.plan as Array<{commands: string[]}>
    assert.equal(plan.length, 4, '2 conversations x 2 runs')
    assert.match(plan[0].commands[0], /^sf agent preview start --authoring-bundle CustomerServiceAgent --use-live-actions --target-org passport-dev --json$/)
  })

  it('refuses the stamp on the real Dev-org trace, and verify exits 1 (the gate stops submit)', async () => {
    copySession(p.root, 'bundle-live', AGENT, 'real-1', '2026-10-23T09:00:00.000Z')
    copySession(p.root, 'bundle-live', AGENT, 'real-2', '2026-10-23T09:01:00.000Z')
    const stamp = await agentia(['passport', 'stamp', '--agent', AGENT, '--env', 'Passport-Dev', ...d])
    assert.equal(stamp.code, 0, stamp.stdout + stamp.stderr)
    assert.match(stamp.stdout, /REFUSED/)
    assert.match(stamp.stdout, /\{!state\.issue_type\}/, 'shows the unfilled merge field the real agent sent to escalate_case')

    const verify = await agentia(['passport', 'verify', '--env', 'Passport-Dev', ...d, '--json'])
    assert.equal(verify.code, 1, 'a failed passport must give a non-zero exit, also with --json')
    assert.equal(parseEnvelope(verify.stdout).result.passed, false)
  })

  it('grants the stamp when fresh runs pass, and verify exits 0 until the agent changes', async () => {
    const good = [{actions: [{input: {subject: 'Duplicate charge refund'}, name: 'create_case'}], reply: 'Your case number is 00001026.', topic: 'resolution', transitions: ['triage', 'resolution'], utterance: REFUND}]
    writeSession(p.root, AGENT, 'fixed-1', '2026-10-23T11:00:00.000Z', good)
    writeSession(p.root, AGENT, 'fixed-2', '2026-10-23T11:01:00.000Z', good)
    const stamp = await agentia(['passport', 'stamp', '--agent', AGENT, '--env', 'Passport-Dev', '--since', '2026-10-23T10:00:00Z', ...d, '--json'])
    assert.equal(stamp.code, 0, stamp.stdout + stamp.stderr)
    assert.equal((parseEnvelope(stamp.stdout).result.stamp as {verdict: string}).verdict, 'stamped')
    assert.ok(existsSync(join(p.root, 'passport', 'stamps', 'Passport-Dev', `${AGENT}.json`)))

    const valid = await agentia(['passport', 'verify', '--env', 'Passport-Dev', '--agent', AGENT, ...d])
    assert.equal(valid.code, 0, valid.stdout + valid.stderr)
    assert.match(valid.stdout, /PASSPORT VALID for Passport-Dev/)

    // Without --agent, every agent in the project needs a stamp: the sample's HelloWorld agent has none.
    const whole = await agentia(['passport', 'verify', '--env', 'Passport-Dev', ...d])
    assert.equal(whole.code, 1)
    assert.match(whole.stdout, /no Passport-Dev stamp[\s\S]*HelloWorld/)

    p.edit(CSA_AGENT_FILE, (t) => `${t}\n# changed after stamping\n`)
    const stale = await agentia(['passport', 'verify', '--env', 'Passport-Dev', '--agent', AGENT, ...d])
    assert.equal(stale.code, 1)
    assert.match(stale.stdout, /PASSPORT NOT VALID/)
  })
})
