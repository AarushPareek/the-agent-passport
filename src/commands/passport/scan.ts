import {AgentiaCommand, getAgentiaHost} from '@copado/agentia-plugin-sdk'
import {Flags} from '@oclif/core'
import {resolve} from 'node:path'

import {ProjectError} from '../../core/project.ts'
import {DEFAULT_GRAPH_PATH, runScan, writeScanResult} from '../../core/scan.ts'

export default class PassportScan extends AgentiaCommand {
  static override description =
    'Map everything an Agentforce agent depends on (subagents/topics, actions, Flows, Apex, prompt templates, agent user) and flag problems that break deployment or publishing. Reads local files only.'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --agent CustomerServiceAgent',
    '<%= config.bin %> <%= command.id %> --project-dir ../my-sfdx-project --json',
  ]

  static override flags = {
    agent: Flags.string({char: 'a', description: 'Only scan this agent (developer name, bundle folder, or bot name)'}),
    write: Flags.boolean({allowNo: true, default: true, description: `Write the graph file (use --no-write to skip)`}),
    out: Flags.string({default: DEFAULT_GRAPH_PATH, description: 'Where to write the graph, relative to the project directory'}),
    'project-dir': Flags.string({char: 'd', default: '.', description: 'Salesforce DX project directory (contains sfdx-project.json)'}),
  }

  public async run() {
    const {flags} = await this.parse(PassportScan)
    // Keep this list in sync with "agentia.requires" in package.json.
    const host = getAgentiaHost({requires: ['format.table']})
    const root = resolve(flags['project-dir'])

    let result
    try {
      result = runScan(root, {agent: flags.agent})
    } catch (error) {
      if (error instanceof ProjectError) this.error(error.message, {exit: 2})
      throw error
    }
    const written = flags.write ? writeScanResult(result, root, flags.out) : undefined

    this.display(() => {
      this.log(
        host.format.table(
          [
            {field: 'agent', header: 'Agent'},
            {field: 'model', header: 'Model'},
            {align: 'right', field: 'present', header: 'In project'},
            {align: 'right', field: 'standard', header: 'Platform'},
            {align: 'right', field: 'missing', header: 'Missing'},
            {align: 'right', field: 'findings', header: 'Findings'},
          ],
          result.agents.map((g) => ({
            agent: g.agent,
            findings: result.findings.filter((f) => f.agent === g.agent).length,
            missing: g.nodes.filter((n) => n.status === 'missing').length,
            model: g.model,
            present: g.nodes.filter((n) => n.status === 'present' && !['Agent', 'AgentAction', 'Subagent'].includes(n.type)).length,
            standard: g.nodes.filter((n) => n.status === 'standard').length,
          })),
        ),
      )
      if (result.findings.length > 0) {
        this.log(
          host.format.table(
            [
              {field: 'severity', header: 'Severity'},
              {field: 'code', header: 'Finding'},
              {field: 'agent', header: 'Agent'},
              {field: 'message', header: 'Detail', wrap: true},
            ],
            result.findings,
          ),
        )
      }
      const s = result.summary
      this.log(`${s.agents} agent(s): ${s.errors} error(s), ${s.warnings} warning(s), ${s.infos} info.`)
      if (written) this.log(`Graph written to ${written}`)
    })

    return {...result, graphPath: written}
  }
}
