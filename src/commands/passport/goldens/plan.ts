import {AgentiaCommand} from '@copado/agentia-plugin-sdk'
import {Flags} from '@oclif/core'
import {resolve} from 'node:path'

import {loadSuite, runPlan, validateSuite} from '../../../core/goldens.ts'
import {ProjectError} from '../../../core/project.ts'
import {runScan} from '../../../core/scan.ts'

export default class PassportGoldensPlan extends AgentiaCommand {
  static override description =
    'Print the exact `sf agent preview` commands that run every golden conversation the required number of times. Run them from the project directory (Salesforce CLI saves the traces there), then run `agentia passport stamp`.'

  static override examples = ['<%= config.bin %> <%= command.id %> --agent CustomerServiceAgent --target-org passport-dev']

  static override flags = {
    agent: Flags.string({char: 'a', description: 'Agent (developer name, bundle folder, or bot name)', required: true}),
    'project-dir': Flags.string({char: 'd', default: '.', description: 'Salesforce DX project directory'}),
    simulate: Flags.boolean({default: false, description: 'Use --simulate-actions instead of real actions (a simulated stamp is marked as such)'}),
    'target-org': Flags.string({char: 'o', description: 'Salesforce CLI alias of the org to test in', required: true}),
  }

  public async run() {
    const {flags} = await this.parse(PassportGoldensPlan)
    const root = resolve(flags['project-dir'])
    let suite
    let problems: string[]
    try {
      const graph = runScan(root, {agent: flags.agent}).agents[0]
      suite = loadSuite(root, graph.agent).suite
      problems = validateSuite(suite, graph)
    } catch (error) {
      if (error instanceof ProjectError) this.error(error.message, {exit: 2})
      throw error
    }
    if (problems.length > 0) this.error(`Fix the golden conversations first:\n  ${problems.join('\n  ')}`, {exit: 2})
    const plan = runPlan(suite, flags['target-org'], {simulate: flags.simulate})
    this.display(() => {
      this.log(`# ${plan.length} preview session(s): ${suite.conversations.length} conversation(s) x ${suite.runsPerConversation} run(s). Run from ${root}`)
      for (const p of plan) this.log(`\n# ${p.conversation}, run ${p.run}\n${p.commands.join('\n')}`)
    })
    return {plan, projectDir: root}
  }
}
