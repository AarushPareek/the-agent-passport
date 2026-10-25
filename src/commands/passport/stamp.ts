import {AgentiaCommand, getAgentiaHost} from '@copado/agentia-plugin-sdk'
import {Flags} from '@oclif/core'
import {resolve} from 'node:path'

import {ProjectError} from '../../core/project.ts'
import {runStamp} from '../../core/stamp.ts'

export default class PassportStamp extends AgentiaCommand {
  static override description =
    "Score the saved `sf agent preview` sessions against the agent's golden conversations and grant or refuse this environment's stamp. Reports regressions against the last good baseline. Reads local files only."

  static override examples = ['<%= config.bin %> <%= command.id %> --env Passport-Dev --agent CustomerServiceAgent']

  static override flags = {
    agent: Flags.string({char: 'a', description: 'Agent (developer name, bundle folder, or bot name)', required: true}),
    env: Flags.string({char: 'e', description: 'Environment this stamp is for, for example Passport-Dev', required: true}),
    'project-dir': Flags.string({char: 'd', default: '.', description: 'Salesforce DX project directory'}),
    since: Flags.string({description: 'Only use preview sessions that started at or after this time (ISO 8601)'}),
    'update-baseline': Flags.boolean({default: false, description: 'Replace the baseline with this run when the stamp is granted'}),
  }

  public async run() {
    const {flags} = await this.parse(PassportStamp)
    const host = getAgentiaHost({requires: ['format.table']})
    const root = resolve(flags['project-dir'])
    let out
    try {
      out = runStamp(root, {agent: flags.agent, environment: flags.env, since: flags.since, updateBaseline: flags['update-baseline']})
    } catch (error) {
      if (error instanceof ProjectError) this.error(error.message, {exit: 2})
      throw error
    }
    const {stamp} = out
    this.display(() => {
      this.log(
        host.format.table(
          [
            {field: 'id', header: 'Conversation'},
            {align: 'right', field: 'runs', header: 'Runs'},
            {align: 'right', field: 'rate', header: 'Pass rate'},
            {field: 'result', header: 'Result'},
            {field: 'why', header: 'First failure', wrap: true},
          ],
          stamp.goldens.map((g) => ({
            id: g.id,
            rate: `${Math.round(g.passRate * 100)}%`,
            result: g.passed ? 'pass' : g.regression === 'was-passing' ? 'REGRESSION' : 'fail',
            runs: `${g.runs.length}/${g.required}`,
            why: g.runs.flatMap((r) => r.checks).find((c) => !c.passed)?.detail ?? (g.regression === 'route-changed' ? 'route differs from baseline' : ''),
          })),
        ),
      )
      for (const p of stamp.problems) this.log(`  ! ${p}`)
      this.log(stamp.verdict === 'stamped' ? `STAMPED: ${stamp.agent} passed in ${stamp.environment} (${stamp.mode} actions).` : `REFUSED: ${stamp.agent} is not stamped for ${stamp.environment}.`)
      this.log(`Stamp written to ${out.stampFile}${out.baselineWritten ? `; baseline written to ${out.baselineWritten}` : ''}`)
    })
    return {...out}
  }
}
