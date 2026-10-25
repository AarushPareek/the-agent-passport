import {AgentiaCommand, getAgentiaHost} from '@copado/agentia-plugin-sdk'
import {Args} from '@oclif/core'

import {buildHelloReport} from '../../core/hello.ts'

export default class PassportHello extends AgentiaCommand {
  static override description =
    'Check that Agent Passport is wired into the Agentia CLI: credentials, workspace, and the active user story with its acceptance criteria'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> US-0000001',
    '<%= config.bin %> <%= command.id %> --json',
  ]

  static override args = {
    story: Args.string({description: 'User story Id or name (defaults to the active story from `agentia cicd work set`)', required: false}),
  }

  public async run() {
    const {args} = await this.parse(PassportHello)
    // Keep this list in sync with "agentia.requires" in package.json.
    const host = getAgentiaHost({requires: ['auth.status', 'format.table', 'work.getWorkItem', 'workspace.current']})
    const report = await buildHelloReport(host, args.story)

    this.display(() => {
      this.log(`Agent Passport is connected to Agentia CLI ${report.cliVersion}`)
      this.log(
        host.format.table(
          [
            {field: 'service', header: 'Service'},
            {field: 'configured', header: 'Configured'},
            {field: 'ready', header: 'Ready'},
            {field: 'source', header: 'Source'},
          ],
          report.auth,
        ),
      )
      const ws = report.workspace
      this.log(ws.found ? `Workspace: branch ${ws.branch ?? '-'}, base ${ws.baseBranch ?? '-'}, story ${ws.workItemName ?? '-'}` : `Workspace: not available (${ws.error})`)
      const wi = report.workItem
      if (wi.found) {
        const ac = wi.acceptanceCriteria
        this.log(`Story ${wi.name ?? wi.id}: ${wi.title ?? ''} [${wi.status ?? '-'}]`)
        this.log(ac.present ? `Acceptance criteria: ${ac.lineCount} line(s), ${ac.length} characters\n${ac.text}` : 'Acceptance criteria: none on this story')
      } else {
        this.log(`Story: not available (${wi.error})`)
      }
    })

    return report
  }
}
