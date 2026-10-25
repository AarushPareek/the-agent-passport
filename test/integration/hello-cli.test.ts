import assert from 'node:assert/strict'
import {before, describe, it} from 'node:test'

import {AGENTIA_BIN, agentia, parseEnvelope} from '../helpers/agentia-cli.ts'

// Precondition (checked, not assumed): the plugin is built and linked into the real CLI:
//   npm run build && agentia plugins link .
describe('passport hello inside the real Agentia CLI', () => {
  before(async () => {
    const plugins = await agentia(['plugins'])
    assert.equal(plugins.code, 0, `Could not run "${AGENTIA_BIN} plugins": ${plugins.stderr}`)
    assert.match(plugins.stdout, /agentia-plugin-passport/, 'Plugin is not linked. Run: npm run build && agentia plugins link .')
  })

  it('is registered under the passport topic', async () => {
    const help = await agentia(['passport', 'hello', '--help'])
    assert.equal(help.code, 0, help.stderr)
    assert.match(help.stdout, /agentia passport hello \[STORY\]/)
  })

  it('runs, resolves every required host method, and returns the JSON envelope', async () => {
    const out = await agentia(['passport', 'hello', '--json'])
    assert.doesNotMatch(out.stdout + out.stderr, /update the CLI/i, 'The CLI is missing a host method listed in agentia.requires')
    assert.equal(out.code, 0, out.stderr)
    const envelope = parseEnvelope(out.stdout)
    assert.equal(envelope.status, 0)
    const result = envelope.result as {auth: Array<{service: string}>; cliVersion: string; workItem: {found: boolean}; workspace: {found: boolean}}
    assert.match(result.cliVersion, /^\d+\.\d+\.\d+/)
    assert.deepEqual(result.auth.map((row) => row.service).sort(), ['ai', 'cicd', 'crt'])
    assert.equal(typeof result.workItem.found, 'boolean')
    assert.equal(typeof result.workspace.found, 'boolean')
  })
})
