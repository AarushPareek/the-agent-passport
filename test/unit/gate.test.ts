import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {delimiter, join} from 'node:path'
import {after, describe, it} from 'node:test'
import {fileURLToPath} from 'node:url'

import {GATE_CMD, GATE_SH, installedGateCommand, installGate, verifyArgs, withBlock} from '../../src/core/gate.ts'

const GATES = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'gates')
// Agentia CLI 1.1.0's own sample gates (see test/fixtures/gates/README.md).
const STOCK_SH = readFileSync(join(GATES, 'stock.sh'), 'utf8')
const STOCK_CMD = readFileSync(join(GATES, 'stock.cmd'), 'utf8')
const OPTIONS = {agent: 'CustomerServiceAgent', environment: 'Passport-Dev', travelTo: 'Passport-QA'}
const isWindows = process.platform === 'win32'

const dirs: string[] = []
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'passport-gate-'))
  dirs.push(d)
  return d
}
after(() => {
  for (const d of dirs) rmSync(d, {force: true, recursive: true})
})
const lines = (text: string) => text.split(/\r?\n/)

describe('verifyArgs', () => {
  it('builds the verify command from the setup options', () => {
    assert.deepEqual(verifyArgs(OPTIONS), ['passport', 'verify', '--env', 'Passport-Dev', '--agent', 'CustomerServiceAgent', '--travel-to', 'Passport-QA'])
    assert.deepEqual(verifyArgs({environment: 'Passport-Dev', requireLive: true, travelToBranch: 'main'}), ['passport', 'verify', '--env', 'Passport-Dev', '--travel-to-branch', 'main', '--require-live'])
  })

  it('refuses values that could break out of a shell command, instead of trying to escape them', () => {
    for (const bad of ['Dev"; rm -rf ~', 'Dev & del *', 'Dev`id`', 'Dev$(id)', 'Dev!x!', 'Dev%PATH%']) {
      assert.throws(() => verifyArgs({environment: bad}), /not allowed in a gate script/, bad)
    }
  })
})

describe('withBlock on Agentia\'s own sample gates', () => {
  it('adds the Passport block after the preamble, before the first check, and keeps every original line in order', () => {
    for (const [stock, kind] of [[STOCK_SH, 'sh'], [STOCK_CMD, 'cmd']] as const) {
      const out = withBlock(stock, kind, kind === 'sh' ? ['# >>> agent-passport X >>>', 'agentia passport verify', '# <<< agent-passport <<<'] : ['REM >>> agent-passport X >>>', 'call agentia passport verify', 'REM <<< agent-passport <<<'])!
      const got = lines(out)
      const verify = got.findIndex((l) => l.includes('passport verify'))
      const firstCheck = got.findIndex((l) => l.includes('Code Analyzer'))
      assert.ok(verify > 0 && verify < firstCheck, `${kind}: passport runs before the existing checks`)
      assert.deepEqual(got.filter((l) => !l.includes('agent-passport') && !l.includes('passport verify')).filter(Boolean), lines(stock).filter(Boolean), `${kind}: original lines kept`)
    }
  })

  it('uses LF for .sh and CRLF for .cmd', () => {
    assert.ok(!withBlock(STOCK_SH, 'sh', ['x'])!.includes('\r\n'))
    assert.equal(withBlock(STOCK_CMD, 'cmd', ['x'])!.split('\n').length, withBlock(STOCK_CMD, 'cmd', ['x'])!.split('\r\n').length)
  })
})

describe('installGate', () => {
  it('creates both scripts when the project has none (shebang, strict mode, `call` on Windows, executable .sh)', () => {
    const d = tempDir()
    assert.deepEqual(installGate(d, OPTIONS).map((c) => c.action), ['created', 'created'])
    const sh = readFileSync(join(d, GATE_SH), 'utf8')
    const cmd = readFileSync(join(d, GATE_CMD), 'utf8')
    assert.match(sh, /^#!\/usr\/bin\/env bash\nset -euo pipefail\n/)
    assert.match(sh, /\nagentia passport verify --env Passport-Dev --agent CustomerServiceAgent --travel-to Passport-QA \|\| exit \$\?\n/)
    assert.match(cmd, /\r\ncall agentia passport verify --env Passport-Dev --agent CustomerServiceAgent --travel-to Passport-QA\r\nif errorlevel 1 exit \/b %errorlevel%\r\n/)
    if (!isWindows) assert.equal(statSync(join(d, GATE_SH)).mode & 0o111, 0o111)
    assert.equal(installedGateCommand(d), 'agentia passport verify --env Passport-Dev --agent CustomerServiceAgent --travel-to Passport-QA')
  })

  it('adds itself to existing gates, is idempotent, updates in place, and removes cleanly', () => {
    const d = tempDir()
    writeFileSync(join(d, GATE_SH), STOCK_SH)
    writeFileSync(join(d, GATE_CMD), STOCK_CMD)
    assert.deepEqual(installGate(d, OPTIONS).map((c) => c.action), ['added', 'added'])
    assert.deepEqual(installGate(d, OPTIONS).map((c) => c.action), ['unchanged', 'unchanged'])
    assert.deepEqual(installGate(d, {...OPTIONS, requireLive: true}).map((c) => c.action), ['updated', 'updated'])
    const sh = readFileSync(join(d, GATE_SH), 'utf8')
    assert.equal(sh.match(/passport verify/g)?.length, 1, 'one block, not two')
    assert.match(sh, /--require-live/)
    assert.deepEqual(installGate(d, undefined).map((c) => c.action), ['removed', 'removed'])
    assert.equal(readFileSync(join(d, GATE_SH), 'utf8'), STOCK_SH, '.sh is back to exactly what it was')
    assert.equal(readFileSync(join(d, GATE_CMD), 'utf8'), STOCK_CMD, '.cmd is back to exactly what it was')
    assert.equal(installedGateCommand(d), undefined)
  })
})

/**
 * Run the generated gate for real, with a fake `agentia` first on PATH that records its arguments and exits with the
 * code we choose. This proves the script passes the arguments through and stops with verify's exit code.
 */
describe('the generated gate script, executed', () => {
  function runGate(verifyExit: number) {
    const d = tempDir()
    const bin = join(d, 'fake-bin')
    mkdirSync(bin)
    installGate(d, {environment: 'Passport-Dev', travelToBranch: 'main'})
    const log = join(d, 'args.txt')
    if (isWindows) {
      writeFileSync(join(bin, 'agentia.cmd'), `@echo off\r\necho %*> "${log}"\r\nexit /b ${verifyExit}\r\n`)
      writeFileSync(join(d, GATE_CMD), `${readFileSync(join(d, GATE_CMD), 'utf8')}echo AFTER-PASSPORT\r\n`)
    } else {
      writeFileSync(join(bin, 'agentia'), `#!/usr/bin/env bash\necho "$*" > "${log}"\nexit ${verifyExit}\n`, {mode: 0o755})
      writeFileSync(join(d, GATE_SH), `${readFileSync(join(d, GATE_SH), 'utf8')}echo AFTER-PASSPORT\n`)
    }
    const env = {...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`}
    const r = isWindows ? spawnSync('cmd.exe', ['/d', '/c', GATE_CMD], {cwd: d, encoding: 'utf8', env}) : spawnSync('bash', [GATE_SH], {cwd: d, encoding: 'utf8', env})
    return {args: readFileSync(log, 'utf8').trim(), code: r.status, out: r.stdout + r.stderr}
  }

  it('passes when verify passes, and the rest of the gate still runs', () => {
    const r = runGate(0)
    assert.equal(r.code, 0, r.out)
    assert.equal(r.args, 'passport verify --env Passport-Dev --travel-to-branch main')
    assert.match(r.out, /AFTER-PASSPORT/)
  })

  it('fails with verify\'s exit code and stops there, so work submit stops', () => {
    const r = runGate(1)
    assert.equal(r.code, 1, r.out)
    assert.doesNotMatch(r.out, /AFTER-PASSPORT/)
  })
})
