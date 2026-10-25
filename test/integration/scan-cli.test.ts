import assert from 'node:assert/strict'
import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {after, before, describe, it} from 'node:test'

import {AGENTIA_BIN, agentia, parseEnvelope} from '../helpers/agentia-cli.ts'
import {tempProject} from '../helpers/fixtures.ts'

// Precondition (checked, not assumed): the plugin is built and linked into the real CLI:
//   npm run build && agentia plugins link .
describe('passport scan inside the real Agentia CLI', () => {
  const project = tempProject('agent-script-recipes')

  before(async () => {
    const plugins = await agentia(['plugins'])
    assert.equal(plugins.code, 0, `Could not run "${AGENTIA_BIN} plugins": ${plugins.stderr}`)
    assert.match(plugins.stdout, /agentia-plugin-passport/, 'Plugin is not linked. Run: npm run build && agentia plugins link .')
  })
  after(() => project.cleanup())

  it('scans a project, prints the JSON envelope, and writes passport/graph.json', async () => {
    const out = await agentia(['passport', 'scan', '--project-dir', project.root, '--json'])
    assert.equal(out.code, 0, out.stdout + out.stderr)
    const envelope = parseEnvelope(out.stdout)
    assert.equal(envelope.status, 0)
    const result = envelope.result as {agents: Array<{agent: string}>; findings: Array<{code: string}>; graphPath: string; summary: {agents: number; errors: number}}
    assert.equal(result.summary.agents, 2)
    assert.ok(result.findings.some((f) => f.code === 'NAME_MISMATCH'))
    const graphFile = join(project.root, 'passport', 'graph.json')
    assert.ok(existsSync(graphFile), 'graph.json written')
    assert.equal(JSON.parse(readFileSync(graphFile, 'utf8')).agents.length, 2)
  })

  it('runs from inside the project directory by default, and --no-write skips the file', async () => {
    project.remove('passport')
    const out = await agentia(['passport', 'scan', '--agent', 'CustomerServiceAgent', '--no-write', '--json'], {cwd: project.root})
    assert.equal(out.code, 0, out.stdout + out.stderr)
    assert.deepEqual(
      (parseEnvelope(out.stdout).result as {agents: Array<{agent: string}>}).agents.map((a) => a.agent),
      ['CustomerService_Agent'],
    )
    assert.equal(existsSync(join(project.root, 'passport', 'graph.json')), false)
  })

  it('prints readable tables without --json', async () => {
    const out = await agentia(['passport', 'scan', '--no-write'], {cwd: project.root})
    assert.equal(out.code, 0, out.stdout + out.stderr)
    assert.match(out.stdout, /NAME_MISMATCH/)
    assert.match(out.stdout, /2 agent\(s\): 1 error\(s\), 3 warning\(s\)/)
  })

  it('fails with exit code 2 and a clear message outside a Salesforce DX project', async () => {
    const out = await agentia(['passport', 'scan', '--project-dir', join(project.root, 'force-app'), '--json'])
    assert.notEqual(out.code, 0)
    assert.match(out.stdout + out.stderr, /No sfdx-project\.json/)
  })

  it('fails clearly for an agent name that does not exist', async () => {
    const out = await agentia(['passport', 'scan', '--agent', 'Nope', '--no-write'], {cwd: project.root})
    assert.notEqual(out.code, 0)
    assert.match(out.stdout + out.stderr, /No agent named "Nope"/)
  })
})
