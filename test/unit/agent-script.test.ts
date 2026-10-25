import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, it} from 'node:test'

import {parseAgentScript} from '../../src/core/agent-script.ts'
import {CSA_AGENT_FILE, fixtureProject} from '../helpers/fixtures.ts'

const SCRIPT = `# Demo agent
config:
   developer_name: "Demo_Agent"
   agent_label: "Demo Agent"
   agent_type: "AgentforceServiceAgent"

access:
    default_agent_user: "__AGENT_USER_PLACEHOLDER__"

system:
   instructions: "Be helpful. target: \\"flow://NotAnAction\\""

start_agent router:
   description: "Route"
   reasoning:
      instructions:|
         Pick a tool. Note: this text has a colon.
         target: "flow://ProseNotTarget"
      actions:
         go_help: @utils.transition to @subagent.help
            description: "Go to help"

subagent help:
   description: "Help"
   actions:
      lookup:
         description: "Look up a record"
         inputs:
            record_id: string
               description: "Id"
         target: "apex://LookupRecord"
      summarize:
         target: "generatePromptResponse://Summarize_Record"
   reasoning:
      instructions:->
         run @actions.lookup
         | Tell the user the result. target: "flow://AlsoProse"
         if @variables.done:
            transition to @subagent.wrap_up
`

describe('parseAgentScript', () => {
  const script = parseAgentScript(SCRIPT)

  it('reads config values', () => {
    assert.equal(script.developerName, 'Demo_Agent')
    assert.equal(script.agentLabel, 'Demo Agent')
    assert.equal(script.agentType, 'AgentforceServiceAgent')
  })

  it('reads the agent user from the access block', () => {
    assert.equal(script.defaultAgentUser, '__AGENT_USER_PLACEHOLDER__')
  })

  it('reads the agent user when it is written inside config instead', () => {
    const s = parseAgentScript('config:\n   developer_name: "X"\n   default_agent_user: "agentuser@example.com"\n')
    assert.equal(s.defaultAgentUser, 'agentuser@example.com')
  })

  it('finds start_agent and subagent blocks in order', () => {
    assert.deepEqual(
      script.blocks.map((b) => [b.kind, b.name]),
      [
        ['start_agent', 'router'],
        ['subagent', 'help'],
      ],
    )
  })

  it('reads action targets with their scheme, and only from action definitions', () => {
    const help = script.blocks[1]
    assert.deepEqual(
      help.actions.map((a) => [a.name, a.target?.scheme, a.target?.name]),
      [
        ['lookup', 'apex', 'LookupRecord'],
        ['summarize', 'generatePromptResponse', 'Summarize_Record'],
      ],
    )
  })

  it('does not treat a reasoning tool (name: @utils.transition ...) as an action', () => {
    assert.deepEqual(script.blocks[0].actions, [])
  })

  it('ignores "target:" text inside instructions, text blocks and | lines', () => {
    const all = script.blocks.flatMap((b) => b.actions.map((a) => a.target?.raw))
    for (const prose of ['flow://NotAnAction', 'flow://ProseNotTarget', 'flow://AlsoProse']) assert.ok(!all.includes(prose), prose)
  })

  it('finds both transition forms: the @utils tool and the direct statement', () => {
    assert.deepEqual(script.blocks[0].transitions, ['help'])
    assert.deepEqual(script.blocks[1].transitions, ['wrap_up'])
  })

  it('handles Windows line endings and tab indentation', () => {
    const crlf = SCRIPT.replace(/\n/g, '\r\n').replace(/^ {3}/gm, '\t')
    const s = parseAgentScript(crlf)
    assert.equal(s.developerName, 'Demo_Agent')
    assert.equal(s.blocks[1].actions.length, 2)
  })

  it('returns an empty result for an empty file', () => {
    assert.deepEqual(parseAgentScript(''), {blocks: []})
  })

  it('reads the real Customer Service Agent from Salesforce\'s sample', () => {
    const real = parseAgentScript(readFileSync(join(fixtureProject('agent-script-recipes'), ...CSA_AGENT_FILE.split('/')), 'utf8'))
    assert.equal(real.developerName, 'CustomerService_Agent')
    assert.equal(real.agentType, 'AgentforceServiceAgent')
    assert.deepEqual(
      real.blocks.map((b) => b.name),
      ['agent_router', 'triage', 'resolution'],
    )
    assert.deepEqual(
      real.blocks.flatMap((b) => b.actions.map((a) => `${b.name}.${a.name}=${a.target?.raw}`)),
      [
        'triage.fetch_customer=flow://FetchCustomer',
        'triage.classify_issue=apex://IssueClassifier',
        'triage.search_knowledge_base=flow://SearchKnowledgeBase',
        'resolution.create_case=flow://CreateCase',
        'resolution.escalate_case=flow://EscalateCase',
      ],
    )
    assert.deepEqual(real.blocks[0].transitions, ['triage'])
    assert.deepEqual(real.blocks[1].transitions, ['resolution'])
  })
})
