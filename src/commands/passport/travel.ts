import {AgentiaCommand, getAgentiaHost} from '@copado/agentia-plugin-sdk'
import {Flags} from '@oclif/core'
import {resolve} from 'node:path'

import {branchOf} from '../../core/pipeline.ts'
import {ProjectError} from '../../core/project.ts'
import {runTravel, writeTravelResult} from '../../core/travel.ts'

export default class PassportTravel extends AgentiaCommand {
  static override description =
    "Check whether everything an Agentforce agent needs will arrive in the target environment when this story is promoted: each dependency must be in the story's committed changes or already on the target branch. Also lists what metadata cannot carry (agent user, publish and activate) as ready-to-add Copado deployment steps."

  static override examples = [
    '<%= config.bin %> <%= command.id %> --to Passport-QA',
    '<%= config.bin %> <%= command.id %> --to-branch main --agent CustomerServiceAgent',
    '<%= config.bin %> <%= command.id %> --to Passport-QA --fetch --json',
  ]

  static override flags = {
    agent: Flags.string({char: 'a', description: 'Only check this agent (developer name, bundle folder, or bot name)'}),
    fetch: Flags.boolean({default: false, description: 'Run `git fetch origin <branch>` first, so the target branch is current'}),
    out: Flags.string({description: 'Where to write the result, relative to the project directory (default: passport/travel-<target>.json)'}),
    pipeline: Flags.string({description: 'Copado pipeline Id or name (default: the pipeline of your current Copado project)'}),
    'project-dir': Flags.string({char: 'd', default: '.', description: 'Salesforce DX project directory (contains sfdx-project.json)'}),
    to: Flags.string({description: 'Target Copado environment name; its branch is looked up in the pipeline', exactlyOne: ['to', 'to-branch']}),
    'to-branch': Flags.string({description: 'Target Git branch, if you already know it (works offline)', exactlyOne: ['to', 'to-branch']}),
    write: Flags.boolean({allowNo: true, default: true, description: 'Write the result file (use --no-write to skip)'}),
  }

  public async run() {
    const {flags} = await this.parse(PassportTravel)
    // Keep this list in sync with "agentia.requires" in package.json.
    const host = getAgentiaHost({requires: ['format.table', 'pipeline.get', 'pipeline.list', 'project.current']})
    const root = resolve(flags['project-dir'])

    let result
    try {
      const targetBranch = flags['to-branch'] ?? (await branchOf(host, flags.to!, flags.pipeline))
      result = runTravel(root, {agent: flags.agent, fetch: flags.fetch, targetBranch, targetEnvironment: flags.to})
    } catch (error) {
      if (error instanceof ProjectError) this.error(error.message, {exit: 2})
      throw error
    }
    const written = flags.write ? writeTravelResult(result, root, flags.out) : undefined

    this.display(() => {
      const t = result.target
      this.log(`Target: ${t.environment ? `${t.environment} (branch ${t.branch}, compared with ${t.ref})` : `branch ${t.branch} (${t.ref})`}`)
      this.log(`Story: ${result.story.branch ?? 'detached HEAD'}, ${result.story.committedFiles} committed file change(s), ${result.story.uncommittedFiles} uncommitted`)
      this.log(
        host.format.table(
          [
            {field: 'agent', header: 'Agent'},
            {align: 'right', field: 'inStory', header: 'In story'},
            {align: 'right', field: 'onTarget', header: 'On target'},
            {align: 'right', field: 'platform', header: 'Platform'},
            {align: 'right', field: 'gaps', header: 'Gaps'},
            {align: 'right', field: 'requirements', header: 'Manual steps'},
          ],
          result.agents.map((a) => ({
            agent: a.agent,
            gaps: a.items.filter((i) => i.status === 'gap').length,
            inStory: a.items.filter((i) => i.status === 'in-story').length,
            onTarget: a.items.filter((i) => i.status === 'on-target').length,
            platform: a.items.filter((i) => i.status === 'platform').length,
            requirements: a.requirements.length,
          })),
        ),
      )
      if (result.findings.length > 0) {
        this.log(
          host.format.table(
            [
              {field: 'severity', header: 'Severity'},
              {field: 'code', header: 'Finding'},
              {field: 'message', header: 'Detail', wrap: true},
            ],
            result.findings,
          ),
        )
      }
      this.log(result.ok ? `Everything the agent needs will arrive in ${t.environment ?? t.branch}.` : `${result.summary.gaps} dependency gap(s): the agent will not work in ${t.environment ?? t.branch} as promoted.`)
      if (written) this.log(`Result written to ${written}`)
    })

    return {...result, resultPath: written}
  }
}
