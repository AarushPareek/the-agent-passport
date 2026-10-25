import assert from 'node:assert/strict'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {after, describe, it} from 'node:test'

import {installSkill, MANAGED_MARKER, removeSkill, SKILL_SOURCE} from '../../src/core/skill.ts'

const dirs: string[] = []
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'passport-skill-'))
  dirs.push(d)
  return d
}
after(() => {
  for (const d of dirs) rmSync(d, {force: true, recursive: true})
})
const SKILL = readFileSync(join(SKILL_SOURCE, 'SKILL.md'), 'utf8')

describe('the agent-passport SKILL.md', () => {
  it('has Agent Skills frontmatter: a name matching its folder and a usable description', () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(SKILL.replace(/\r\n/g, '\n'))?.[1] ?? ''
    assert.match(front, /^name: agent-passport$/m)
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? ''
    assert.ok(description.length > 50 && description.length <= 1024, `description length ${description.length}`)
    assert.doesNotMatch(description, /[<>]/)
  })

  it('only mentions passport commands and flags that exist', async () => {
    const commands: Record<string, string> = {
      'goldens init': 'goldens/init.ts',
      'goldens plan': 'goldens/plan.ts',
      report: 'report.ts',
      scan: 'scan.ts',
      setup: 'setup.ts',
      stamp: 'stamp.ts',
      travel: 'travel.ts',
      verify: 'verify.ts',
    }
    const text = readFileSync(join(SKILL_SOURCE, 'SKILL.md'), 'utf8') + readFileSync(join(SKILL_SOURCE, 'references', 'writing-goldens.md'), 'utf8')
    const uses = [...text.matchAll(/agentia passport ((?:goldens )?[a-z]+)([^`\n]*)/g)]
    assert.ok(uses.length >= 8, 'the skill walks through the commands')
    for (const [, name, rest] of uses) {
      assert.ok(commands[name], `unknown command "agentia passport ${name}"`)
      const {default: Command} = await import(`../../src/commands/passport/${commands[name]}`)
      for (const [, flag] of rest.matchAll(/--([a-z-]+)/g)) {
        assert.ok(flag in Command.flags || flag === 'json', `"agentia passport ${name}" has no --${flag}`)
      }
    }
  })

  it('tells the agent the rules that keep the stamp honest', () => {
    for (const rule of [/Never make a failing check pass by weakening it/, /--skip-local-tests/, /Fix the \*\*agent\*\*/, /\.sfdx\/agents\/\*\*\/sessions\//]) assert.match(SKILL, rule)
  })

  it('uses Agentia MCP tools that exist in CLI 1.1.0 for deployment steps', () => {
    // Names from the Agentia CLI 1.1.0 MCP tool registry.
    // Tool names only: not the `agentia_*` wildcard in prose, not the .agentia_quality_gates file name.
    const tools = SKILL.match(/(?<![.\w])agentia_[a-z_]*[a-z]/g) ?? []
    assert.ok(tools.length >= 4)
    for (const tool of tools) {
      assert.ok(['agentia_work_deployment_step_create', 'agentia_work_deployment_step_list', 'agentia_work_get', 'agentia_work_test'].includes(tool), tool)
    }
  })
})

describe('installSkill and removeSkill', () => {
  it('installs into Agentia\'s skill folders, with the managed marker, and is idempotent', () => {
    const d = tempDir()
    const first = installSkill(d, ['agents', 'claude'])
    assert.deepEqual(first.map((c) => `${c.action} ${c.file}`), [
      'created .agents/skills/agent-passport/SKILL.md',
      'created .agents/skills/agent-passport/references/writing-goldens.md',
      'created .claude/skills/agent-passport/SKILL.md',
      'created .claude/skills/agent-passport/references/writing-goldens.md',
    ])
    assert.ok(readFileSync(join(d, '.agents', 'skills', 'agent-passport', 'SKILL.md'), 'utf8').includes(MANAGED_MARKER))
    assert.ok(installSkill(d, ['agents', 'claude']).every((c) => c.action === 'unchanged'))
  })

  it('refreshes its own files, but never overwrites a file someone else wrote unless forced', () => {
    const d = tempDir()
    installSkill(d, ['agents'])
    const file = join(d, '.agents', 'skills', 'agent-passport', 'SKILL.md')
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nold version\n`)
    assert.equal(installSkill(d, ['agents'])[0].action, 'updated')

    const cursor = join(d, '.cursor', 'skills', 'agent-passport')
    mkdirSync(cursor, {recursive: true})
    writeFileSync(join(cursor, 'SKILL.md'), '# my own notes\n')
    assert.equal(installSkill(d, ['cursor'])[0].action, 'conflict')
    assert.equal(readFileSync(join(cursor, 'SKILL.md'), 'utf8'), '# my own notes\n')
    assert.equal(installSkill(d, ['cursor'], {force: true})[0].action, 'updated')
  })

  it('removes only managed files, and the folders it leaves empty', () => {
    const d = tempDir()
    installSkill(d, ['agents', 'claude'])
    writeFileSync(join(d, '.claude', 'skills', 'agent-passport', 'NOTES.md'), 'mine\n')
    const removed = removeSkill(d, ['agents', 'claude'])
    assert.equal(removed.filter((c) => c.action === 'removed').length, 4)
    assert.deepEqual(removed.filter((c) => c.action === 'conflict').map((c) => c.file), ['.claude/skills/agent-passport/NOTES.md'])
    assert.ok(!existsSync(join(d, '.agents', 'skills', 'agent-passport')))
    assert.ok(existsSync(join(d, '.claude', 'skills', 'agent-passport', 'NOTES.md')))
  })
})
