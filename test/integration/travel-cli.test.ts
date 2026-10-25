import assert from 'node:assert/strict'
import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {after, before, describe, it} from 'node:test'

import {AGENTIA_BIN, agentia, parseEnvelope} from '../helpers/agentia-cli.ts'
import {gitProject} from '../helpers/git-fixture.ts'

// Precondition (checked, not assumed): the plugin is built and linked into the real CLI:
//   npm run build && agentia plugins link .
describe('passport travel inside the real Agentia CLI', () => {
  const p = gitProject('agent-script-recipes')

  before(async () => {
    const plugins = await agentia(['plugins'])
    assert.equal(plugins.code, 0, `Could not run "${AGENTIA_BIN} plugins": ${plugins.stderr}`)
    assert.match(plugins.stdout, /agentia-plugin-passport/, 'Plugin is not linked. Run: npm run build && agentia plugins link .')
    p.git('checkout', '-qb', 'feature/US-0000001')
    p.git('add', 'sfdx-project.json', 'force-app', 'force-app-service')
    p.git('reset', '-q', '--', 'force-app-service/customerServiceAgent/flows/EscalateCase.flow-meta.xml')
    p.git('commit', '-qm', 'story that forgot EscalateCase')
  })
  after(() => p.cleanup())

  it('resolves every required host method and reports the forgotten Flow as a gap', async () => {
    const out = await agentia(['passport', 'travel', '--to-branch', 'main', '--agent', 'CustomerServiceAgent', '--json'], {cwd: p.root})
    assert.doesNotMatch(out.stdout + out.stderr, /update the CLI/i, 'The CLI is missing a host method listed in agentia.requires')
    assert.equal(out.code, 0, out.stdout + out.stderr)
    const result = parseEnvelope(out.stdout).result as {findings: Array<{code: string; component?: string}>; ok: boolean; resultPath: string; summary: {gaps: number}}
    assert.equal(result.ok, false)
    assert.equal(result.summary.gaps, 1)
    assert.ok(result.findings.some((f) => f.code === 'TRAVEL_GAP' && f.component === 'Flow:EscalateCase'))
    assert.ok(existsSync(join(p.root, 'passport', 'travel-main.json')))
    assert.equal(JSON.parse(readFileSync(join(p.root, 'passport', 'travel-main.json'), 'utf8')).summary.gaps, 1)
  })

  it('prints a readable summary without --json', async () => {
    const out = await agentia(['passport', 'travel', '--to-branch', 'main', '--agent', 'CustomerServiceAgent', '--no-write'], {cwd: p.root})
    assert.equal(out.code, 0, out.stdout + out.stderr)
    assert.match(out.stdout, /TRAVEL_GAP/)
    assert.match(out.stdout, /REQUIREMENT_PUBLISH_ACTIVATE/)
    assert.match(out.stdout, /1 dependency gap\(s\)/)
  })

  it('needs exactly one of --to and --to-branch', async () => {
    const neither = await agentia(['passport', 'travel', '--no-write'], {cwd: p.root})
    assert.notEqual(neither.code, 0)
    const both = await agentia(['passport', 'travel', '--to', 'Passport-QA', '--to-branch', 'main', '--no-write'], {cwd: p.root})
    assert.notEqual(both.code, 0)
  })

  it('fails with a clear message for a branch that does not exist', async () => {
    const out = await agentia(['passport', 'travel', '--to-branch', 'does-not-exist', '--no-write'], {cwd: p.root})
    assert.notEqual(out.code, 0)
    assert.match(out.stdout + out.stderr, /Branch "does-not-exist" was not found/)
  })

  it('with --to, looks the branch up in the Copado pipeline, or explains how to work offline', async () => {
    const out = await agentia(['passport', 'travel', '--to', 'Passport-QA', '--agent', 'CustomerServiceAgent', '--no-write', '--json'], {cwd: p.root})
    if (out.code === 0) {
      // Signed in to Copado and the active project's pipeline has Passport-QA: the branch came from the pipeline.
      const result = parseEnvelope(out.stdout).result as {target: {environment: string; resolvedFrom: string}}
      assert.equal(result.target.resolvedFrom, 'pipeline')
      assert.equal(result.target.environment, 'Passport-QA')
    } else {
      // Not signed in (or no project selected): a helpful message, not a crash.
      assert.match(out.stdout + out.stderr, /Could not look up the Copado pipeline|is not in pipeline|has no pipeline|not found locally/)
    }
  })
})
