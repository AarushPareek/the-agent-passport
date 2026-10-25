import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {after, before, describe, it} from 'node:test'

import {AGENTIA_BIN, agentia, oneLine, parseEnvelope} from '../helpers/agentia-cli.ts'
import {CSA_AGENT_FILE, tempProject} from '../helpers/fixtures.ts'

// Precondition (checked, not assumed): the plugin is built and linked into the real CLI.
describe('passport report inside the real Agentia CLI', () => {
  const p = tempProject('agent-script-recipes')
  const d = ['--project-dir', p.root]

  before(async () => {
    const plugins = await agentia(['plugins'])
    assert.equal(plugins.code, 0, `Could not run "${AGENTIA_BIN} plugins": ${plugins.stderr}`)
    assert.match(plugins.stdout, /agentia-plugin-passport/, 'Plugin is not linked. Run: npm run build && agentia plugins link .')
    p.edit(CSA_AGENT_FILE, (t) => t.replace('developer_name: "CustomerService_Agent"', 'developer_name: "CustomerServiceAgent"'))
  })
  after(() => p.cleanup())

  it('writes passport/report.html and exits 0 even when the passport is not valid (verify is the gate, not report)', async () => {
    const out = await agentia(['passport', 'report', '--env', 'Passport-Dev', '--agent', 'CustomerServiceAgent', ...d, '--json'])
    assert.equal(out.code, 0, out.stdout + out.stderr)
    const result = parseEnvelope(out.stdout).result as {file: string; valid: boolean}
    assert.equal(result.valid, false)
    assert.equal(result.file, join(p.root, 'passport', 'report.html'))
    const html = readFileSync(result.file, 'utf8')
    assert.match(html, /NOT VALID/)
    assert.match(html, /no Passport-Dev stamp/)
  })

  it('prints a summary table and the file path without --json, and honours --out', async () => {
    const out = await agentia(['passport', 'report', '--env', 'Passport-Dev', '--agent', 'CustomerServiceAgent', '--out', 'passport/US-0000025.html', ...d])
    assert.equal(out.code, 0, out.stdout + out.stderr)
    assert.match(out.stdout, /NOT VALID/)
    assert.match(out.stdout, /US-0000025\.html/)
  })

  it('explains clearly when travel cannot be checked outside a Git repository', async () => {
    const out = await agentia(['passport', 'report', '--env', 'Passport-Dev', '--travel-to-branch', 'main', ...d])
    assert.equal(out.code, 2)
    assert.match(oneLine(out.stdout + out.stderr), /is not inside a Git repository\. Travel compares your story branch with the target branch/)
  })
})
