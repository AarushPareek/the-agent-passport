import {AgentiaCommand, getAgentiaHost} from '@copado/agentia-plugin-sdk'
import {Flags} from '@oclif/core'
import {existsSync} from 'node:fs'
import {join, resolve} from 'node:path'

import {draftSuite, goldensPath, saveSuite, splitCriteria} from '../../../core/goldens.ts'
import {ProjectError} from '../../../core/project.ts'
import {runScan} from '../../../core/scan.ts'

export default class PassportGoldensInit extends AgentiaCommand {
  static override description =
    "Draft golden conversations for an agent from a user story's acceptance criteria (read through Agentia), one per criterion, with the subagent and actions each criterion names. Utterances are left for you or your coding agent to write."

  static override examples = [
    '<%= config.bin %> <%= command.id %> --agent CustomerServiceAgent --story US-0000025',
    '<%= config.bin %> <%= command.id %> --agent CustomerServiceAgent',
    '<%= config.bin %> <%= command.id %> --agent CustomerServiceAgent --criteria "A refund request routes to the resolution subagent."',
  ]

  static override flags = {
    agent: Flags.string({char: 'a', description: 'Agent to test (developer name, bundle folder, or bot name)', required: true}),
    criteria: Flags.string({description: 'Acceptance criteria text to use instead of reading a user story (works offline)', exclusive: ['story']}),
    force: Flags.boolean({default: false, description: 'Overwrite an existing goldens file'}),
    'pass-threshold': Flags.integer({default: 100, description: 'Percentage of runs that must pass', max: 100, min: 1}),
    'project-dir': Flags.string({char: 'd', default: '.', description: 'Salesforce DX project directory'}),
    runs: Flags.integer({default: 3, description: 'Runs per conversation (LLM routing varies, so one run proves little)', min: 1}),
    story: Flags.string({description: 'User story Id or name (default: the active story from `agentia cicd work set`)'}),
  }

  public async run() {
    const {flags} = await this.parse(PassportGoldensInit)
    // Keep this list in sync with "agentia.requires" in package.json.
    const host = getAgentiaHost({requires: ['work.getWorkItem']})
    const root = resolve(flags['project-dir'])

    let graph
    try {
      const scan = runScan(root, {agent: flags.agent})
      if (scan.agents.length !== 1) throw new ProjectError(`"${flags.agent}" matches ${scan.agents.length} agents; name one.`)
      graph = scan.agents[0]
    } catch (error) {
      if (error instanceof ProjectError) this.error(error.message, {exit: 2})
      throw error
    }

    let text = flags.criteria ?? ''
    let story: string | undefined
    let source = flags.criteria ? 'the --criteria flag' : ''
    if (!flags.criteria) {
      try {
        const item = await host.work.getWorkItem(flags.story)
        text = item.acceptanceCriteria ?? ''
        story = item.name ?? item.id
        source = `user story ${story}`
      } catch (error) {
        if (flags.story) this.error(`Could not read user story ${flags.story}: ${error instanceof Error ? error.message : String(error)}`, {exit: 2})
        source = 'the agent\'s subagents (no active user story)'
      }
    }

    const file = join(root, goldensPath(graph.agent))
    if (existsSync(file) && !flags.force) this.error(`${file} already exists. Edit it, or pass --force to replace it.`, {exit: 2})
    const suite = draftSuite(graph, splitCriteria(text), {passThreshold: flags['pass-threshold'] / 100, runs: flags.runs, story})
    const written = saveSuite(root, suite)

    this.display(() => {
      this.log(`Drafted ${suite.conversations.length} golden conversation(s) for ${graph.agent} from ${source}.`)
      for (const g of suite.conversations) {
        const e = g.turns[0].expect
        const parts = [e.topic && `routes to ${e.topic}`, e.actionsInclude?.length && `runs ${e.actionsInclude.join(', ')}`, e.actionsExclude?.length && `never runs ${e.actionsExclude.join(', ')}`].filter(Boolean)
        this.log(`  ${g.id}: ${g.criterion ?? '(route test)'}\n        expects: ${parts.join('; ') || 'nothing yet (add by hand)'}`)
      }
      this.log(`Written to ${written}. Next: write each "utterance", then run \`agentia passport goldens plan --agent ${graph.agent} --target-org <alias>\`.`)
    })
    return {file: written, source, suite}
  }
}
