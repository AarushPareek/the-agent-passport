import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, it} from 'node:test'

import {isNamespaced} from '../../src/core/graph.ts'
import type {AgentGraph, ScanResult} from '../../src/core/model.ts'
import {ProjectError} from '../../src/core/project.ts'
import {runScan, writeScanResult} from '../../src/core/scan.ts'
import {CSA_AGENT_FILE, fixtureProject, tempProject} from '../helpers/fixtures.ts'

const codes = (r: ScanResult, agent?: string) =>
  r.findings
    .filter((f) => agent === undefined || f.agent === agent)
    .map((f) => `${f.severity} ${f.code}`)
    .sort()
const edge = (g: AgentGraph, from: string, kind: string, to: string) => g.edges.some((e) => e.from === from && e.kind === kind && e.to === to)
const status = (g: AgentGraph, id: string) => g.nodes.find((n) => n.id === id)?.status

describe('isNamespaced', () => {
  it('recognises platform namespaces but not custom suffixes', () => {
    assert.equal(isNamespaced('SvcCopilotTmpl__VerifyCustomer'), true)
    assert.equal(isNamespaced('EmployeeCopilot__AnswerQuestionsWithKnowledge'), true)
    assert.equal(isNamespaced('Session__c'), false)
    assert.equal(isNamespaced('Setting__mdt'), false)
    assert.equal(isNamespaced('Get_Sessions'), false)
  })
})

describe('scan: Agent Script model (Salesforce agent-script-recipes)', () => {
  const result = runScan(fixtureProject('agent-script-recipes'))
  const csa = result.agents.find((g) => g.agent === 'CustomerService_Agent')!

  it('finds both agents, named by developer_name', () => {
    assert.deepEqual(
      result.agents.map((g) => [g.agent, g.model]),
      [
        ['CustomerService_Agent', 'agent-script'],
        ['HelloWorld', 'agent-script'],
      ],
    )
  })

  it('reports exactly the problems we hit for real during setup', () => {
    assert.deepEqual(codes(result, 'CustomerService_Agent'), [
      'error NAME_MISMATCH',
      'warn AGENT_USER_PLACEHOLDER_UNRESOLVED',
      'warn BUNDLE_OUTSIDE_DEFAULT_PACKAGE',
      'warn DUPLICATE_COMPONENT',
    ])
    assert.deepEqual(codes(result, 'HelloWorld'), [], 'a healthy agent in the default directory has no findings')
  })

  it('names the duplicate and both of its locations', () => {
    const dup = result.findings.find((f) => f.code === 'DUPLICATE_COMPONENT')!
    assert.equal(dup.component, 'Flow:CreateCase')
    assert.deepEqual(
      dup.locations?.map((l) => l.packageDir),
      ['force-app', 'force-app-service'],
    )
  })

  it('maps subagents, routing, actions and what each action runs', () => {
    assert.ok(edge(csa, 'Agent:CustomerService_Agent', 'defined-by', 'AiAuthoringBundle:CustomerServiceAgent'))
    assert.ok(edge(csa, 'Subagent:CustomerService_Agent.agent_router', 'transitions-to', 'Subagent:CustomerService_Agent.triage'))
    assert.ok(edge(csa, 'Subagent:CustomerService_Agent.triage', 'transitions-to', 'Subagent:CustomerService_Agent.resolution'))
    assert.ok(edge(csa, 'AgentAction:CustomerService_Agent.triage.classify_issue', 'invokes', 'ApexClass:IssueClassifier'))
    assert.ok(edge(csa, 'AgentAction:CustomerService_Agent.resolution.create_case', 'invokes', 'Flow:CreateCase'))
    assert.ok(edge(csa, 'Agent:CustomerService_Agent', 'runs-as', 'AgentUser:__AGENT_USER_PLACEHOLDER__'))
    for (const id of ['Flow:FetchCustomer', 'Flow:SearchKnowledgeBase', 'Flow:CreateCase', 'Flow:EscalateCase', 'ApexClass:IssueClassifier']) assert.equal(status(csa, id), 'present', id)
    assert.equal(status(csa, 'AgentUser:__AGENT_USER_PLACEHOLDER__'), 'external')
  })

  it('uses forward-slash paths relative to the project root', () => {
    assert.equal(csa.source.path, CSA_AGENT_FILE)
    assert.ok(result.agents.every((g) => g.nodes.every((n) => n.locations.every((l) => !l.path.includes('\\')))))
  })

  it('summarises counts that match the findings', () => {
    assert.deepEqual(result.summary, {agents: 2, errors: 1, infos: 0, missing: 0, standard: 0, warnings: 3})
  })
})

describe('scan: classic model (Salesforce coral-cloud)', () => {
  const result = runScan(fixtureProject('coral-cloud'))
  const service = result.agents.find((g) => g.agent === 'Coral_Cloud_Agent')!
  const employee = result.agents.find((g) => g.agent === 'Coral_Cloud_Employee_Agent')!

  it('finds both bots', () => {
    assert.deepEqual(
      result.agents.map((g) => [g.agent, g.model, g.agentType]),
      [
        ['Coral_Cloud_Agent', 'classic', 'EinsteinServiceAgent'],
        ['Coral_Cloud_Employee_Agent', 'classic', 'AgentforceEmployeeAgent'],
      ],
    )
  })

  it('follows Bot -> version -> planner -> topic -> action -> Flow/Apex/prompt template -> data', () => {
    assert.ok(edge(service, 'Bot:Coral_Cloud_Agent', 'has-version', 'BotVersion:Coral_Cloud_Agent.v1'))
    assert.ok(edge(service, 'BotVersion:Coral_Cloud_Agent.v1', 'uses-planner', 'GenAiPlannerBundle:Coral_Cloud_Agent'))
    assert.ok(edge(service, 'GenAiPlannerBundle:Coral_Cloud_Agent', 'has-topic', 'GenAiPlugin:Verified_Customer_Support'))
    assert.ok(edge(service, 'GenAiPlugin:Verified_Customer_Support', 'has-action', 'GenAiFunction:Check_Weather'))
    assert.ok(edge(service, 'GenAiFunction:Check_Weather', 'invokes', 'ApexClass:CheckWeather'))
    assert.ok(edge(service, 'GenAiFunction:Create_Booking', 'invokes', 'Flow:Create_Booking'))
    assert.ok(edge(service, 'GenAiFunction:Generate_Personalized_Schedule_SA', 'invokes', 'GenAiPromptTemplate:Generate_Personalized_Schedule'))
    assert.ok(edge(service, 'GenAiPromptTemplate:Generate_Personalized_Schedule', 'uses-data', 'ApexClass:PersonalizedGuestExperiences'))
  })

  it('treats platform-provided topics and actions as standard, not missing', () => {
    assert.equal(status(service, 'GenAiPlugin:SvcCopilotTmpl__ServiceCustomerVerification'), 'standard')
    assert.equal(status(service, 'GenAiFunction:SvcCopilotTmpl__VerifyCustomer'), 'standard')
    assert.equal(status(employee, 'GenAiFunction:EmployeeCopilot__AnswerQuestionsWithKnowledge'), 'standard')
    assert.equal(result.summary.missing, 0)
  })

  it('accepts a placeholder agent user that sfdx-project.json replaces at deploy time', () => {
    assert.deepEqual(codes(result), ['info AGENT_USER_PLACEHOLDER'])
    assert.equal(result.findings[0].agent, 'Coral_Cloud_Agent')
  })
})

describe('scan: deliberately broken copies', () => {
  it('reports a Flow that an action needs but the project lacks', () => {
    const p = tempProject('agent-script-recipes')
    try {
      p.remove('force-app-service/customerServiceAgent/flows/EscalateCase.flow-meta.xml')
      const r = runScan(p.root, {agent: 'CustomerServiceAgent'})
      const missing = r.findings.filter((f) => f.code === 'MISSING_DEPENDENCY')
      assert.equal(missing.length, 1)
      assert.equal(missing[0].component, 'Flow:EscalateCase')
      assert.equal(missing[0].severity, 'error')
      assert.match(missing[0].message, /AgentAction:CustomerService_Agent\.resolution\.escalate_case/)
    } finally {
      p.cleanup()
    }
  })

  it('reports a classic action whose Apex class is gone', () => {
    const p = tempProject('coral-cloud')
    try {
      p.remove('cc-employee-app/main/default/classes/CheckWeather.cls')
      const r = runScan(p.root, {agent: 'Coral_Cloud_Agent'})
      assert.deepEqual(
        r.findings.filter((f) => f.code === 'MISSING_DEPENDENCY').map((f) => f.component),
        ['ApexClass:CheckWeather'],
      )
    } finally {
      p.cleanup()
    }
  })

  it('reports a routing target that the script never defines', () => {
    const p = tempProject('agent-script-recipes')
    try {
      p.edit(CSA_AGENT_FILE, (t) => t.replace('transition to @subagent.resolution', 'transition to @subagent.billing_desk'))
      const r = runScan(p.root, {agent: 'CustomerServiceAgent'})
      const f = r.findings.find((x) => x.component === 'Subagent:CustomerService_Agent.billing_desk')
      assert.ok(f, 'missing subagent reported')
      assert.match(f.message, /routes to subagent "billing_desk"/)
    } finally {
      p.cleanup()
    }
  })

  it('flags an org-specific username written into the agent (what the setup script did in Dev)', () => {
    const p = tempProject('agent-script-recipes')
    try {
      p.edit(CSA_AGENT_FILE, (t) => t.replace('__AGENT_USER_PLACEHOLDER__', 'agent.user.0000@example.com'))
      const r = runScan(p.root, {agent: 'CustomerServiceAgent'})
      assert.ok(codes(r).includes('warn AGENT_USER_HARDCODED'))
      assert.ok(!codes(r).some((c) => c.includes('PLACEHOLDER')))
    } finally {
      p.cleanup()
    }
  })

  it('accepts the placeholder once sfdx-project.json gets a matching replacement', () => {
    const p = tempProject('agent-script-recipes')
    try {
      p.edit('sfdx-project.json', (t) => {
        const json = JSON.parse(t)
        json.replacements = [{filename: CSA_AGENT_FILE, replaceWithEnv: 'AGENT_USERNAME', stringToReplace: '__AGENT_USER_PLACEHOLDER__'}]
        return JSON.stringify(json, null, 2)
      })
      const r = runScan(p.root, {agent: 'CustomerServiceAgent'})
      assert.ok(codes(r).includes('info AGENT_USER_PLACEHOLDER'))
      assert.ok(!codes(r).includes('warn AGENT_USER_PLACEHOLDER_UNRESOLVED'))
    } finally {
      p.cleanup()
    }
  })

  it('clears NAME_MISMATCH once developer_name matches the folder (the fix we applied in Dev)', () => {
    const p = tempProject('agent-script-recipes')
    try {
      p.edit(CSA_AGENT_FILE, (t) => t.replace('developer_name: "CustomerService_Agent"', 'developer_name: "CustomerServiceAgent"'))
      const r = runScan(p.root, {agent: 'CustomerServiceAgent'})
      assert.equal(r.agents[0].agent, 'CustomerServiceAgent')
      assert.ok(!codes(r).includes('error NAME_MISMATCH'))
    } finally {
      p.cleanup()
    }
  })

  it('warns when a service agent has no agent user at all', () => {
    const p = tempProject('agent-script-recipes')
    try {
      p.edit(CSA_AGENT_FILE, (t) => t.replace(/^access:\n\s+default_agent_user: .*\n/m, ''))
      const r = runScan(p.root, {agent: 'CustomerServiceAgent'})
      assert.ok(codes(r).includes('warn AGENT_USER_MISSING'))
    } finally {
      p.cleanup()
    }
  })
})

describe('scan options and output', () => {
  it('filters by bundle folder, developer name or bot name, case-insensitively', () => {
    assert.deepEqual(
      runScan(fixtureProject('agent-script-recipes'), {agent: 'customerserviceagent'}).agents.map((g) => g.agent),
      ['CustomerService_Agent'],
    )
    assert.deepEqual(
      runScan(fixtureProject('agent-script-recipes'), {agent: 'CustomerService_Agent'}).agents.map((g) => g.agent),
      ['CustomerService_Agent'],
    )
    assert.deepEqual(
      runScan(fixtureProject('coral-cloud'), {agent: 'coral_cloud_agent'}).agents.map((g) => g.agent),
      ['Coral_Cloud_Agent'],
    )
  })

  it('explains an unknown agent name and lists the real ones', () => {
    assert.throws(
      () => runScan(fixtureProject('coral-cloud'), {agent: 'Nope'}),
      (e: unknown) => e instanceof ProjectError && /No agent named "Nope".*Coral_Cloud_Agent, Coral_Cloud_Employee_Agent/.test(e.message),
    )
  })

  it('writes passport/graph.json deterministically (same input, same bytes)', () => {
    const p = tempProject('agent-script-recipes')
    try {
      const first = readFileSync(writeScanResult(runScan(p.root), p.root), 'utf8')
      const second = readFileSync(writeScanResult(runScan(p.root), p.root), 'utf8')
      assert.equal(first, second)
      const parsed = JSON.parse(readFileSync(join(p.root, 'passport', 'graph.json'), 'utf8')) as ScanResult
      assert.equal(parsed.schemaVersion, 1)
      assert.equal(parsed.agents.length, 2)
    } finally {
      p.cleanup()
    }
  })
})
