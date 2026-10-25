import assert from 'node:assert/strict'
import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {after, before, describe, it} from 'node:test'

import {saveSuite} from '../../src/core/goldens.ts'
import {AGENTIA_BIN, agentia, parseEnvelope} from '../helpers/agentia-cli.ts'
import {CSA_AGENT_FILE} from '../helpers/fixtures.ts'
import {gitProject} from '../helpers/git-fixture.ts'
import {writeSession} from '../helpers/sessions.ts'

const AGENT = 'CustomerServiceAgent'
const REFUND = 'I was charged twice for my last order and I want a refund'
const isWindows = process.platform === 'win32'
const GATE = isWindows ? '.agentia_quality_gates.cmd' : '.agentia_quality_gates.sh'

// Precondition (checked, not assumed): the plugin is built and linked into the real CLI:
//   npm run build && agentia plugins link .
// Runs offline: no Copado key or Git remote is needed for `work test`, which runs the local gate.
describe('the Passport quality gate inside the real `agentia cicd work test`', () => {
  const p = gitProject('agent-script-recipes')
  const d = ['--project-dir', p.root]
  const workTest = () => agentia(['cicd', 'work', 'test', '--json'], {cwd: p.root})

  before(async () => {
    const plugins = await agentia(['plugins'])
    assert.equal(plugins.code, 0, `Could not run "${AGENTIA_BIN} plugins": ${plugins.stderr}`)
    assert.match(plugins.stdout, /agentia-plugin-passport/, 'Plugin is not linked. Run: npm run build && agentia plugins link .')
    p.edit(CSA_AGENT_FILE, (t) => t.replace('developer_name: "CustomerService_Agent"', `developer_name: "${AGENT}"`))
    p.git('checkout', '-qb', 'feature/US-0000025')
    p.git('add', 'sfdx-project.json', 'force-app', 'force-app-service')
    p.git('commit', '-qm', 'the agent and everything it needs')
  })
  after(() => p.cleanup())

  it('setup installs the gate scripts and the skill', async () => {
    const out = await agentia(['passport', 'setup', '--env', 'Passport-Dev', '--agent', AGENT, '--travel-to-branch', 'main', '--target', 'agents', '--target', 'claude', ...d, '--json'])
    assert.equal(out.code, 0, out.stdout + out.stderr)
    const result = parseEnvelope(out.stdout).result as {gate: Array<{action: string}>; gateCommand: string; skill: Array<{action: string}>}
    assert.equal(result.gateCommand, `agentia passport verify --env Passport-Dev --agent ${AGENT} --travel-to-branch main`)
    assert.deepEqual(result.gate.map((c) => c.action), ['created', 'created'])
    assert.equal(result.skill.filter((c) => c.action === 'created').length, 4)
    assert.ok(existsSync(join(p.root, '.agents', 'skills', 'agent-passport', 'SKILL.md')))
    assert.ok(existsSync(join(p.root, '.claude', 'skills', 'agent-passport', 'SKILL.md')))
  })

  it('work test fails while the agent has no stamp, and says why', async () => {
    const out = await workTest()
    assert.notEqual(out.code, 0, 'the gate must stop work test (and therefore work submit)')
    assert.match(out.stdout + out.stderr, /PASSPORT NOT VALID for Passport-Dev/)
    assert.match(out.stdout + out.stderr, /Local quality gates failed \(exit 1\)/)
  })

  it('work test passes once the golden conversations pass and the agent is stamped', async () => {
    saveSuite(p.root, {
      agent: AGENT,
      bundle: AGENT,
      conversations: [{criterion: 'A refund request routes to the resolution subagent.', id: 'AC-1', turns: [{expect: {inputsResolved: true, topic: 'resolution'}, utterance: REFUND}]}],
      passThreshold: 1,
      runsPerConversation: 2,
      schemaVersion: 1,
    })
    for (const i of [1, 2]) writeSession(p.root, AGENT, `ok-${i}`, `2026-10-23T12:0${i}:00.000Z`, [{reply: 'I can help with that refund.', topic: 'resolution', transitions: ['triage', 'resolution'], utterance: REFUND}])
    const stamp = await agentia(['passport', 'stamp', '--agent', AGENT, '--env', 'Passport-Dev', ...d])
    assert.match(stamp.stdout, /STAMPED/, stamp.stdout + stamp.stderr)

    const out = await workTest()
    assert.equal(out.code, 0, out.stdout + out.stderr)
    assert.match(out.stdout, /"ran": true/)
  })

  it('work test fails again when the agent changes after stamping', async () => {
    p.edit(CSA_AGENT_FILE, (t) => `${t}\n# edited after the stamp\n`)
    p.commit('change the agent', CSA_AGENT_FILE)
    const out = await workTest()
    assert.notEqual(out.code, 0)
    assert.match(out.stdout + out.stderr, /stamp is stale/)
  })

  it('setup --remove turns the gate off and removes only what it installed', async () => {
    const out = await agentia(['passport', 'setup', '--remove', '--target', 'agents', '--target', 'claude', ...d, '--json'])
    assert.equal(out.code, 0, out.stdout + out.stderr)
    assert.doesNotMatch(readFileSync(join(p.root, GATE), 'utf8'), /passport verify/)
    assert.ok(!existsSync(join(p.root, '.agents', 'skills', 'agent-passport')))
    assert.ok(existsSync(join(p.root, 'passport', 'stamps', 'Passport-Dev', `${AGENT}.json`)), 'evidence is kept')
  })
})
