import {AgentiaCommand, getAgentiaHost} from '@copado/agentia-plugin-sdk'
import {Flags} from '@oclif/core'
import {resolve} from 'node:path'

import {branchOf} from '../../core/pipeline.ts'
import {ProjectError} from '../../core/project.ts'
import {runVerify} from '../../core/stamp.ts'
import {runTravel} from '../../core/travel.ts'

export default class PassportVerify extends AgentiaCommand {
  static override description =
    'The Agent Passport gate. Exits 1 unless every agent scans without errors and holds a granted, current stamp for the environment (optionally: no travel gaps, live actions only). Put it in .agentia_quality_gates so `agentia cicd work submit` runs it.'

  static override examples = [
    '<%= config.bin %> <%= command.id %> --env Passport-Dev',
    '<%= config.bin %> <%= command.id %> --env Passport-Dev --agent CustomerServiceAgent --travel-to Passport-QA --require-live',
    '<%= config.bin %> <%= command.id %> --env Passport-Dev --travel-to-branch main',
  ]

  static override flags = {
    agent: Flags.string({char: 'a', description: 'Only verify this agent'}),
    env: Flags.string({char: 'e', description: 'Environment whose stamp is required, for example Passport-Dev', required: true}),
    pipeline: Flags.string({description: 'Copado pipeline Id or name for --travel-to (default: the pipeline of your current Copado project)'}),
    'project-dir': Flags.string({char: 'd', default: '.', description: 'Salesforce DX project directory'}),
    'require-live': Flags.boolean({default: false, description: 'Reject stamps that used simulated actions'}),
    travel: Flags.string({description: 'Also require a saved travel result with no gaps (path relative to the project directory)', exclusive: ['travel-to', 'travel-to-branch']}),
    'travel-to': Flags.string({description: 'Also check now that everything the agent needs will arrive in this Copado environment (writes nothing)', exclusive: ['travel', 'travel-to-branch']}),
    'travel-to-branch': Flags.string({description: 'Like --travel-to, with the target Git branch given directly (works offline)', exclusive: ['travel', 'travel-to']}),
  }

  public async run() {
    const {flags} = await this.parse(PassportVerify)
    // Keep these lists in sync with "agentia.requires" in package.json. Pipeline access is only needed for --travel-to.
    const host = flags['travel-to']
      ? getAgentiaHost({requires: ['format.table', 'pipeline.get', 'pipeline.list', 'project.current']})
      : getAgentiaHost({requires: ['format.table']})
    const root = resolve(flags['project-dir'])
    let results
    try {
      const travelTo = flags['travel-to']
      const travelBranch = flags['travel-to-branch'] ?? (travelTo ? await branchOf(host as Parameters<typeof branchOf>[0], travelTo, flags.pipeline) : undefined)
      const travel = travelBranch ? runTravel(root, {agent: flags.agent, targetBranch: travelBranch, targetEnvironment: travelTo}) : undefined
      results = runVerify(root, {agent: flags.agent, environment: flags.env, requireLive: flags['require-live'], travel, travelFile: flags.travel})
    } catch (error) {
      if (error instanceof ProjectError) this.error(error.message, {exit: 2})
      throw error
    }
    const passed = results.length > 0 && results.every((r) => r.passed)
    this.display(() => {
      this.log(
        host.format.table(
          [
            {field: 'agent', header: 'Agent'},
            {field: 'name', header: 'Check'},
            {field: 'result', header: 'Result'},
            {field: 'detail', header: 'Detail', wrap: true},
          ],
          results.flatMap((r) => r.checks.map((c) => ({agent: r.agent, detail: c.detail, name: c.name, result: c.passed ? 'pass' : 'FAIL'}))),
        ),
      )
      this.log(passed ? `PASSPORT VALID for ${flags.env}.` : `PASSPORT NOT VALID for ${flags.env}. Fix the failures above before promoting.`)
    })
    // The gate signal: a non-zero exit code makes Agentia's local quality gate (and work submit) stop.
    if (!passed) process.exitCode = 1
    return {environment: flags.env, passed, results}
  }
}
