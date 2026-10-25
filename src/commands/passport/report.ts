import {AgentiaCommand, getAgentiaHost} from '@copado/agentia-plugin-sdk'
import {Flags} from '@oclif/core'
import {resolve} from 'node:path'

import {branchOf} from '../../core/pipeline.ts'
import {ProjectError} from '../../core/project.ts'
import {buildReport, REPORT_PATH, renderReport, writeReport} from '../../core/report.ts'
import {runTravel} from '../../core/travel.ts'

export default class PassportReport extends AgentiaCommand {
  static override description =
    'Write the agent passport as one self-contained HTML page (passport/report.html): the gate verdict, every environment stamp, each golden conversation with its runs and transcripts, travel to the next environment, deployment steps still needed, the dependency map and the evidence hashes. No scripts, no network: open it in any browser or attach it to the story.'

  static override examples = [
    '<%= config.bin %> <%= command.id %> --env Passport-Dev --travel-to Passport-QA',
    '<%= config.bin %> <%= command.id %> --env Passport-Dev --agent CustomerServiceAgent --travel-to-branch main --out passport/US-0000025.html',
  ]

  static override flags = {
    agent: Flags.string({char: 'a', description: 'Only report this agent'}),
    env: Flags.string({char: 'e', description: 'Environment the verdict is for, for example Passport-Dev', required: true}),
    out: Flags.string({default: REPORT_PATH, description: 'Where to write the page, relative to the project directory'}),
    pipeline: Flags.string({description: 'Copado pipeline Id or name for --travel-to (default: the pipeline of your current Copado project)'}),
    'project-dir': Flags.string({char: 'd', default: '.', description: 'Salesforce DX project directory'}),
    travel: Flags.string({description: 'Include a saved travel result (path relative to the project directory)', exclusive: ['travel-to', 'travel-to-branch']}),
    'travel-to': Flags.string({description: 'Include travel to this Copado environment, checked now', exclusive: ['travel', 'travel-to-branch']}),
    'travel-to-branch': Flags.string({description: 'Include travel to this Git branch, checked now (works offline)', exclusive: ['travel', 'travel-to']}),
  }

  public async run() {
    const {flags} = await this.parse(PassportReport)
    // Keep these lists in sync with "agentia.requires" in package.json. Pipeline access is only needed for --travel-to.
    const host = flags['travel-to']
      ? getAgentiaHost({requires: ['format.table', 'pipeline.get', 'pipeline.list', 'project.current']})
      : getAgentiaHost({requires: ['format.table']})
    const root = resolve(flags['project-dir'])
    let data
    try {
      const travelTo = flags['travel-to']
      const branch = flags['travel-to-branch'] ?? (travelTo ? await branchOf(host as Parameters<typeof branchOf>[0], travelTo, flags.pipeline) : undefined)
      const travel = branch ? runTravel(root, {agent: flags.agent, targetBranch: branch, targetEnvironment: travelTo}) : undefined
      data = buildReport(root, {agent: flags.agent, environment: flags.env, travel, travelFile: flags.travel})
    } catch (error) {
      if (error instanceof ProjectError) this.error(error.message, {exit: 2})
      throw error
    }
    const file = writeReport(root, renderReport(data), flags.out)
    this.display(() => {
      this.log(
        host.format.table(
          [
            {field: 'agent', header: 'Agent'},
            {field: 'verdict', header: `Passport for ${flags.env}`},
            {field: 'stamps', header: 'Stamps'},
          ],
          data.agents.map((a) => ({
            agent: a.agent,
            stamps: a.stamps.map((s) => `${s.environment}: ${s.valid ? 'valid' : s.stamp.verdict === 'stamped' ? 'stale' : 'refused'}`).join(', ') || 'none',
            verdict: a.verify.passed ? 'VALID' : 'NOT VALID',
          })),
        ),
      )
      this.log(`Report written to ${file}. Open it in a browser.`)
    })
    // The report is information, not the gate: it always exits 0 (use `verify` to block).
    return {environment: flags.env, file, valid: data.valid}
  }
}
