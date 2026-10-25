// Needs the real Agentia CLI (AGENTIA_BIN). Runs offline: no Copado key or Git remote.
// Checks the Agentia behaviour the passport gate relies on: a failing .agentia_quality_gates script makes
// `work test` fail, and stops `work submit` before it touches Git or Copado.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {after, before, describe, it} from 'node:test'

import {agentia} from '../helpers/agentia-cli.ts'

const isWindows = process.platform === 'win32'
const gateFile = isWindows ? '.agentia_quality_gates.cmd' : '.agentia_quality_gates.sh'
const failingGate = isWindows
  ? '@echo off\r\necho PASSPORT-TEST-GATE: fail\r\nexit /b 3\r\n'
  : '#!/usr/bin/env bash\necho "PASSPORT-TEST-GATE: fail"\nexit 3\n'
const passingGate = isWindows ? '@echo off\r\necho PASSPORT-TEST-GATE: pass\r\nexit /b 0\r\n' : '#!/usr/bin/env bash\necho "PASSPORT-TEST-GATE: pass"\nexit 0\n'

let repo: string
const git = (...args: string[]) => execFileSync('git', args, {cwd: repo, stdio: 'pipe'})
const inRepo = (args: string[]) => agentia(args, {cwd: repo})

describe('Agentia local quality gate (real CLI)', () => {
  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'passport-gate-'))
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    writeFileSync(join(repo, 'README.md'), 'test\n')
    git('add', 'README.md')
    git('commit', '-qm', 'init')
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '.agentia/\n.agentia_quality_gates.*\n')
  })
  after(() => rmSync(repo, {force: true, recursive: true}))

  it('work test fails, and reports the gate exit code, when the gate script fails', async () => {
    writeFileSync(join(repo, gateFile), failingGate, {mode: 0o755})
    const out = await inRepo(['cicd', 'work', 'test', '--json'])
    assert.notEqual(out.code, 0)
    assert.match(out.stdout + out.stderr, /PASSPORT-TEST-GATE: fail/)
    assert.match(out.stdout + out.stderr, /Local quality gates failed \(exit 3\)/)
  })

  it('work test passes and reports ran=true when the gate script passes', async () => {
    writeFileSync(join(repo, gateFile), passingGate, {mode: 0o755})
    const out = await inRepo(['cicd', 'work', 'test', '--json'])
    assert.equal(out.code, 0, out.stdout + out.stderr)
    assert.match(out.stdout, /"ran": true/)
  })

  it('work submit stops at a failing gate, before any Git fetch or Copado call', async () => {
    // A simulated active story: the file `agentia cicd work set` writes (an internal format, used only here).
    git('checkout', '-qb', 'feature/US-0000999')
    mkdirSync(join(repo, '.agentia'), {recursive: true})
    writeFileSync(
      join(repo, '.agentia', 'config.user.json'),
      JSON.stringify({lastBaseBranch: 'main', lastDevOrgBranch: 'dev', lastWorkItem: 'US-0000999', lastWorkItemId: 'a1X000000000001AAA', lastWorkItemTitle: 'test'}),
    )
    writeFileSync(join(repo, gateFile), failingGate, {mode: 0o755})
    const blocked = await inRepo(['cicd', 'work', 'submit', '--skip-pull-request', '--json'])
    assert.notEqual(blocked.code, 0)
    assert.match(blocked.stdout + blocked.stderr, /Local quality gates failed \(exit 3\)/)
    assert.doesNotMatch(blocked.stdout + blocked.stderr, /git fetch/)

    // Control: with the documented bypass flag, submit goes past the gate and fails later, at `git fetch`.
    const bypassed = await inRepo(['cicd', 'work', 'submit', '--skip-pull-request', '--skip-local-tests', '--json'])
    assert.notEqual(bypassed.code, 0)
    assert.match(bypassed.stdout + bypassed.stderr, /git fetch/)
  })
})
