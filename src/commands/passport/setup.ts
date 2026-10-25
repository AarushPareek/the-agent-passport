import {AgentiaCommand, getAgentiaHost} from '@copado/agentia-plugin-sdk'
import {Flags} from '@oclif/core'
import {resolve} from 'node:path'

import {installGate, verifyArgs} from '../../core/gate.ts'
import type {GateChange, GateOptions} from '../../core/gate.ts'
import {installSkill, removeSkill, SKILL_TARGETS} from '../../core/skill.ts'
import type {SkillChange, SkillTarget} from '../../core/skill.ts'

export default class PassportSetup extends AgentiaCommand {
  static override description =
    "Turn Agent Passport on for this project: add `agentia passport verify` to Agentia's local quality gate scripts (.agentia_quality_gates.sh and .cmd), so `agentia cicd work test` and `work submit` stop when the agent's passport is not valid, and install the agent-passport Agent Skill for coding agents. Only the lines between Agent Passport's markers are ever changed; existing gates are kept."

  static override examples = [
    '<%= config.bin %> <%= command.id %> --env Passport-Dev --agent CustomerServiceAgent --travel-to Passport-QA',
    '<%= config.bin %> <%= command.id %> --env Passport-Dev --travel-to-branch main --target agents --target claude',
    '<%= config.bin %> <%= command.id %> --remove',
  ]

  static override flags = {
    agent: Flags.string({char: 'a', description: 'Only gate this agent (default: every agent in the project needs a stamp)'}),
    env: Flags.string({char: 'e', description: 'Environment whose stamp the gate requires, for example Passport-Dev (the story\'s current environment)'}),
    force: Flags.boolean({default: false, description: 'Replace skill files at the same path that Agent Passport did not write'}),
    gate: Flags.boolean({allowNo: true, default: true, description: 'Install the quality gate block (use --no-gate to skip)'}),
    'project-dir': Flags.string({char: 'd', default: '.', description: 'Repository root (where .agentia_quality_gates.* live)'}),
    remove: Flags.boolean({default: false, description: 'Remove the gate block and the managed skill files instead'}),
    'require-live': Flags.boolean({default: false, description: 'The gate rejects stamps from simulated actions'}),
    skill: Flags.boolean({allowNo: true, default: true, description: 'Install the agent-passport Agent Skill (use --no-skill to skip)'}),
    target: Flags.string({default: ['agents'], description: 'Where to install the skill: .agents/skills, .claude/skills or .cursor/skills (repeatable)', multiple: true, options: Object.keys(SKILL_TARGETS)}),
    'travel-to': Flags.string({description: 'The gate also checks that everything the agent needs will arrive in this Copado environment (for example Passport-QA)', exclusive: ['travel-to-branch']}),
    'travel-to-branch': Flags.string({description: 'Like --travel-to, with the target Git branch given directly (works offline)', exclusive: ['travel-to']}),
  }

  public async run() {
    const {flags} = await this.parse(PassportSetup)
    const host = getAgentiaHost({requires: ['format.table']})
    const root = resolve(flags['project-dir'])
    const targets = [...new Set(flags.target)] as SkillTarget[]

    let gateOptions: GateOptions | undefined
    if (!flags.remove && flags.gate) {
      if (!flags.env) this.error('--env is required to install the gate: the environment whose stamp a story needs before it moves on, for example --env Passport-Dev.', {exit: 2})
      gateOptions = {agent: flags.agent, environment: flags.env, requireLive: flags['require-live'], travelTo: flags['travel-to'], travelToBranch: flags['travel-to-branch']}
      try {
        verifyArgs(gateOptions)
      } catch (error) {
        this.error((error as Error).message, {exit: 2})
      }
    }

    const gate: GateChange[] = flags.remove ? installGate(root, undefined) : flags.gate ? installGate(root, gateOptions) : []
    const skill: SkillChange[] = flags.remove ? removeSkill(root, targets) : flags.skill ? installSkill(root, targets, {force: flags.force}) : []
    const conflicts = skill.filter((c) => c.action === 'conflict').map((c) => c.file)
    const gateCommand = gateOptions ? `agentia ${verifyArgs(gateOptions).join(' ')}` : undefined

    this.display(() => {
      const rows = [...gate.map((c) => ({...c, what: 'quality gate'})), ...skill.map((c) => ({...c, what: 'agent skill'}))]
      if (rows.length > 0) {
        this.log(
          host.format.table(
            [
              {field: 'what', header: 'Part'},
              {field: 'file', header: 'File'},
              {field: 'action', header: 'Change'},
            ],
            rows,
          ),
        )
      }
      if (gateCommand) this.log(`The gate now runs: ${gateCommand}\nTry it: agentia cicd work test`)
      if (flags.remove) this.log('Agent Passport is off for this project. Existing gates and passport/ files were kept.')
      for (const file of conflicts) this.log(`  ! ${file} exists and was not written by Agent Passport; left unchanged (use --force to replace it).`)
      this.log('Commit these files so everyone on the story gets the same gate. `--skip-local-tests` on work submit bypasses every local gate, including this one.')
    })
    if (conflicts.length > 0 && !flags.remove) process.exitCode = 1
    return {gate, gateCommand, projectDir: root, removed: flags.remove, skill}
  }
}
