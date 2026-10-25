import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {dirname} from 'node:path'
import {describe, it} from 'node:test'

import type {PluginPipeline} from '@copado/agentia-plugin-sdk'

import {ownerComponent, ProjectError} from '../../src/core/project.ts'
import {branchForEnvironment, environmentNames, runTravel, travelFileName, writeTravelResult} from '../../src/core/travel.ts'
import type {TravelResult} from '../../src/core/travel.ts'
import {CSA_AGENT_FILE, tempProject} from '../helpers/fixtures.ts'
import {gitProject} from '../helpers/git-fixture.ts'

const CSA = 'CustomerService_Agent'
const FLOWS = 'force-app-service/customerServiceAgent/flows'
const item = (r: TravelResult, component: string, agent = CSA) => r.agents.find((a) => a.agent === agent)?.items.find((i) => i.component === component)
const codes = (r: TravelResult, agent = CSA) =>
  r.findings
    .filter((f) => f.agent === agent)
    .map((f) => `${f.severity} ${f.code}${f.component ? ` ${f.component}` : ''}`)
    .sort()

// Shapes copied from the real `agentia cicd pipeline get` output for the two pipelines in our Copado trial.
const passportPipeline: PluginPipeline = {
  connections: [{branch: 'dev', destinationEnvironment: {id: 'a0ckO0000000KbRQAU', name: 'Passport-QA'}, sourceEnvironment: {id: 'a0ckO0000000KZpQAM', name: 'Passport-Dev'}}],
  id: 'a0WkO0000000BTJUA2',
  mainBranch: 'main',
  name: 'Agent Passport Pipeline',
}
const trialPipeline: PluginPipeline = {
  connections: [
    {branch: 'dev1-sfp', destinationEnvironment: {name: 'INT-SFP'}, sourceEnvironment: {name: 'Dev1-SFP'}},
    {branch: 'dev2-sfp', destinationEnvironment: {name: 'INT-SFP'}, sourceEnvironment: {name: 'Dev2-SFP'}},
    {branch: 'int-sfp', destinationEnvironment: {name: 'UAT-SFP'}, sourceEnvironment: {name: 'INT-SFP'}},
    {branch: 'uat-sfp', destinationEnvironment: {name: 'Production-SFP'}, sourceEnvironment: {name: 'UAT-SFP'}},
    {branch: 'hotfix-sfp', destinationEnvironment: {name: 'Production-SFP'}, sourceEnvironment: {name: 'Hotfix-SFP'}},
  ],
  id: 'a0WkO00000009UjUAI',
  mainBranch: 'main',
}

describe('branchForEnvironment', () => {
  it('maps our Dev -> QA pipeline: Dev works on dev, the last stage (QA) on main', () => {
    assert.equal(branchForEnvironment(passportPipeline, 'Passport-Dev'), 'dev')
    assert.equal(branchForEnvironment(passportPipeline, 'passport-qa'), 'main')
    assert.equal(branchForEnvironment(passportPipeline, 'a0ckO0000000KbRQAU'), 'main', 'by environment id')
    assert.equal(branchForEnvironment(passportPipeline, 'Nope'), undefined)
  })

  it('maps every stage of the trial pipeline, including a hotfix lane', () => {
    assert.deepEqual(
      ['Dev1-SFP', 'Dev2-SFP', 'INT-SFP', 'UAT-SFP', 'Production-SFP', 'Hotfix-SFP'].map((e) => branchForEnvironment(trialPipeline, e)),
      ['dev1-sfp', 'dev2-sfp', 'int-sfp', 'uat-sfp', 'main', 'hotfix-sfp'],
    )
    assert.deepEqual(environmentNames(trialPipeline).sort(), ['Dev1-SFP', 'Dev2-SFP', 'Hotfix-SFP', 'INT-SFP', 'Production-SFP', 'UAT-SFP'])
  })
})

describe('ownerComponent', () => {
  const cases: Array<[string, string | undefined]> = [
    ['x/classes/IssueClassifier.cls-meta.xml', 'ApexClass:IssueClassifier'],
    ['x/aiAuthoringBundles/CustomerServiceAgent/CustomerServiceAgent.bundle-meta.xml', 'AiAuthoringBundle:CustomerServiceAgent'],
    ['x/genAiFunctions/Check_Weather/input/schema.json', 'GenAiFunction:Check_Weather'],
    ['x/objects/Session__c/fields/Date__c.field-meta.xml', 'CustomObject:Session__c'],
    ['x/flows/CreateCase.flow-meta.xml', 'Flow:CreateCase'],
    ['README.md', undefined],
  ]
  for (const [path, expected] of cases) {
    it(`${path} -> ${expected ?? 'none'}`, () => {
      const hit = ownerComponent(path)
      assert.equal(hit ? `${hit.type}:${hit.name}` : undefined, expected)
    })
  }
})

describe('travel: Agent Script agent to an empty target', () => {
  it('a story that commits the agent and everything it needs has no gaps', () => {
    const p = gitProject('agent-script-recipes')
    try {
      p.git('checkout', '-qb', 'feature/US-0000001')
      p.commit('story', 'sfdx-project.json', 'force-app', 'force-app-service')
      const r = runTravel(p.root, {agent: 'CustomerServiceAgent', targetBranch: 'main'})
      assert.equal(r.ok, true)
      assert.equal(r.summary.gaps, 0)
      for (const id of ['AiAuthoringBundle:CustomerServiceAgent', 'Flow:CreateCase', 'Flow:EscalateCase', 'Flow:FetchCustomer', 'Flow:SearchKnowledgeBase', 'ApexClass:IssueClassifier']) {
        assert.equal(item(r, id)?.status, 'in-story', id)
      }
      assert.deepEqual(r.target, {branch: 'main', environment: undefined, ref: 'main', resolvedFrom: 'branch-flag'})
      assert.equal(r.story.branch, 'feature/US-0000001')
    } finally {
      p.cleanup()
    }
  })

  it('lists what metadata cannot carry: the agent user, and publish + activate, as proposed deployment steps', () => {
    const p = gitProject('agent-script-recipes')
    try {
      p.git('checkout', '-qb', 'feature/US-0000001')
      p.commit('story', 'sfdx-project.json', 'force-app', 'force-app-service')
      const r = runTravel(p.root, {agent: 'CustomerServiceAgent', targetBranch: 'main', targetEnvironment: 'Passport-QA'})
      const reqs = r.agents[0].requirements
      assert.deepEqual(
        reqs.map((q) => [q.code, q.severity, q.proposedStep.order, q.proposedStep.type]),
        [
          ['REQUIREMENT_AGENT_USER', 'warn', 'before', 'Manual Task'],
          ['REQUIREMENT_PUBLISH_ACTIVATE', 'warn', 'after', 'Manual Task'],
        ],
      )
      assert.match(reqs[1].proposedStep.instructions, /sf agent publish authoring-bundle --api-name CustomerServiceAgent/)
      assert.match(reqs[1].proposedStep.instructions, /sf agent activate --api-name CustomerServiceAgent/)
      assert.match(reqs[0].message, /must already exist in Passport-QA/)
      assert.equal(r.ok, true, 'requirements are reported, but they are not dependency gaps')
    } finally {
      p.cleanup()
    }
  })

  it('a Flow left uncommitted will not arrive (the most common slip)', () => {
    const p = gitProject('agent-script-recipes')
    try {
      p.git('checkout', '-qb', 'feature/US-0000002')
      p.git('add', 'sfdx-project.json', 'force-app', 'force-app-service')
      p.git('reset', '-q', '--', `${FLOWS}/EscalateCase.flow-meta.xml`)
      p.git('commit', '-qm', 'story without EscalateCase')
      const r = runTravel(p.root, {agent: 'CustomerServiceAgent', targetBranch: 'main'})
      assert.equal(r.ok, false)
      assert.deepEqual(item(r, 'Flow:EscalateCase'), {
        component: 'Flow:EscalateCase',
        name: 'EscalateCase',
        neededBy: ['AgentAction:CustomerService_Agent.resolution.escalate_case'],
        reason: 'uncommitted',
        status: 'gap',
        type: 'Flow',
      })
      assert.ok(codes(r).includes('error TRAVEL_GAP Flow:EscalateCase'))
      assert.equal(r.summary.gaps, 1)
    } finally {
      p.cleanup()
    }
  })
})

describe('travel: target that already has some of the agent', () => {
  it('dependencies already on the target branch are fine even when the story does not touch them', () => {
    const p = gitProject('agent-script-recipes')
    try {
      p.commit('target already has the app', 'sfdx-project.json', 'force-app', 'force-app-service')
      p.git('checkout', '-qb', 'feature/US-0000003')
      p.edit(CSA_AGENT_FILE, (t) => t.replace('Customer service agent that classifies', 'Customer service agent that triages'))
      p.commit('change the agent only', CSA_AGENT_FILE)
      const r = runTravel(p.root, {agent: 'CustomerServiceAgent', targetBranch: 'main'})
      assert.equal(r.ok, true)
      assert.equal(item(r, 'AiAuthoringBundle:CustomerServiceAgent')?.status, 'in-story')
      assert.equal(item(r, 'Flow:EscalateCase')?.status, 'on-target')
      assert.equal(item(r, 'ApexClass:IssueClassifier')?.status, 'on-target')
      assert.equal(r.story.committedFiles, 1)
    } finally {
      p.cleanup()
    }
  })

  it('prefers origin/<branch>, the target as last fetched, over a local branch of the same name', () => {
    const p = gitProject('agent-script-recipes')
    try {
      p.commit('target already has the app', 'sfdx-project.json', 'force-app', 'force-app-service')
      p.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
      p.git('checkout', '-qb', 'feature/US-0000004')
      const r = runTravel(p.root, {agent: 'CustomerServiceAgent', targetBranch: 'main'})
      assert.equal(r.target.ref, 'origin/main')
    } finally {
      p.cleanup()
    }
  })

  it('a dependency the target branch lost, and the story does not restore, is a gap', () => {
    const p = gitProject('agent-script-recipes')
    try {
      p.commit('base with the app', 'sfdx-project.json', 'force-app', 'force-app-service')
      p.git('checkout', '-qb', 'qa')
      p.git('rm', '-q', `${FLOWS}/FetchCustomer.flow-meta.xml`)
      p.git('commit', '-qm', 'qa lost FetchCustomer')
      p.git('checkout', '-q', 'main')
      p.git('checkout', '-qb', 'feature/US-0000005')
      p.edit(CSA_AGENT_FILE, (t) => `${t}\n`)
      p.commit('touch agent', CSA_AGENT_FILE)
      const r = runTravel(p.root, {agent: 'CustomerServiceAgent', targetBranch: 'qa'})
      assert.equal(item(r, 'Flow:FetchCustomer')?.reason, 'not-in-story')
      assert.equal(item(r, 'Flow:EscalateCase')?.status, 'on-target')
      assert.equal(r.ok, false)
    } finally {
      p.cleanup()
    }
  })

  it('a story that deletes a Flow the agent still uses is a gap', () => {
    const p = gitProject('agent-script-recipes')
    try {
      p.commit('target has the app', 'sfdx-project.json', 'force-app', 'force-app-service')
      p.git('checkout', '-qb', 'feature/US-0000006')
      p.git('rm', '-q', `${FLOWS}/SearchKnowledgeBase.flow-meta.xml`)
      p.git('commit', '-qm', 'delete a flow')
      const r = runTravel(p.root, {agent: 'CustomerServiceAgent', targetBranch: 'main'})
      assert.equal(item(r, 'Flow:SearchKnowledgeBase')?.reason, 'deleted-in-story')
      assert.ok(codes(r).includes('error TRAVEL_GAP Flow:SearchKnowledgeBase'))
    } finally {
      p.cleanup()
    }
  })

  it('a dependency that exists nowhere is a gap with reason "missing"', () => {
    const p = gitProject('agent-script-recipes')
    try {
      p.remove(`${FLOWS}/FetchCustomer.flow-meta.xml`)
      p.git('checkout', '-qb', 'feature/US-0000007')
      p.commit('story without FetchCustomer', 'sfdx-project.json', 'force-app', 'force-app-service')
      const r = runTravel(p.root, {agent: 'CustomerServiceAgent', targetBranch: 'main'})
      assert.equal(item(r, 'Flow:FetchCustomer')?.reason, 'missing')
    } finally {
      p.cleanup()
    }
  })

  it('warns when a dependency has uncommitted edits, since only the committed version travels', () => {
    const p = gitProject('agent-script-recipes')
    try {
      p.git('checkout', '-qb', 'feature/US-0000008')
      p.commit('story', 'sfdx-project.json', 'force-app', 'force-app-service')
      p.edit(`${FLOWS}/CreateCase.flow-meta.xml`, (t) => t.replace('</Flow>', '<!-- local edit --></Flow>'))
      const r = runTravel(p.root, {agent: 'CustomerServiceAgent', targetBranch: 'main'})
      assert.equal(item(r, 'Flow:CreateCase')?.uncommittedEdits, true)
      assert.ok(codes(r).includes('warn TRAVEL_UNCOMMITTED_EDITS Flow:CreateCase'))
      assert.equal(r.ok, true)
    } finally {
      p.cleanup()
    }
  })

  it('does not ask for publish + activate when the GenAiPlannerBundle travels too', () => {
    const p = gitProject('agent-script-recipes')
    try {
      p.git('checkout', '-qb', 'feature/US-0000009')
      p.writeFile('force-app-service/customerServiceAgent/genAiPlannerBundles/CustomerServiceAgent/CustomerServiceAgent.genAiPlannerBundle', '<GenAiPlannerBundle/>\n')
      p.commit('story with planner bundle', 'sfdx-project.json', 'force-app', 'force-app-service')
      const r = runTravel(p.root, {agent: 'CustomerServiceAgent', targetBranch: 'main'})
      assert.deepEqual(
        r.agents[0].requirements.map((q) => q.code),
        ['REQUIREMENT_AGENT_USER'],
      )
    } finally {
      p.cleanup()
    }
  })
})

describe('travel: classic agents (Coral Cloud)', () => {
  it('counts platform pieces separately, and needs no publish step for a classic bot', () => {
    const p = gitProject('coral-cloud')
    try {
      p.git('checkout', '-qb', 'feature/US-0000010')
      p.commit('story', 'sfdx-project.json', 'cc-base-app', 'cc-employee-app', 'cc-service-app')
      const r = runTravel(p.root, {agent: 'Coral_Cloud_Agent', targetBranch: 'main'})
      const a = r.agents[0]
      assert.equal(a.ok, true)
      assert.equal(a.items.filter((i) => i.status === 'platform').length, 4)
      assert.equal(item(r, 'GenAiPlugin:SvcCopilotTmpl__ServiceCustomerVerification', 'Coral_Cloud_Agent')?.status, 'platform')
      assert.equal(item(r, 'Bot:Coral_Cloud_Agent', 'Coral_Cloud_Agent')?.status, 'in-story')
      assert.deepEqual(
        a.requirements.map((q) => [q.code, q.severity]),
        [['REQUIREMENT_AGENT_USER', 'info']],
      )
    } finally {
      p.cleanup()
    }
  })
})

describe('travel: errors and output', () => {
  it('explains a target branch that does not exist locally', () => {
    const p = gitProject('agent-script-recipes')
    try {
      assert.throws(() => runTravel(p.root, {targetBranch: 'qa'}), (e: unknown) => e instanceof ProjectError && /Branch "qa" was not found.*git fetch origin qa/.test(e.message))
    } finally {
      p.cleanup()
    }
  })

  it('explains a project that is not in a Git repository', () => {
    const p = tempProject('agent-script-recipes')
    // Stop Git from searching above the temp folder. Without this the test depends on the machine: on Windows the temp
    // folder sits inside the user's home folder, and if that is itself a Git repository Git finds it instead.
    const saved = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = dirname(p.root)
    try {
      assert.throws(() => runTravel(p.root, {targetBranch: 'main'}), (e: unknown) => e instanceof ProjectError && /not inside a Git repository/.test(e.message))
    } finally {
      if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = saved
      p.cleanup()
    }
  })

  it('writes passport/travel-<target>.json with a safe file name', () => {
    assert.equal(travelFileName('Passport-QA').replace(/\\/g, '/'), 'passport/travel-Passport-QA.json')
    assert.equal(travelFileName('feature/x y').replace(/\\/g, '/'), 'passport/travel-feature_x_y.json')
    const p = gitProject('agent-script-recipes')
    try {
      p.git('checkout', '-qb', 'feature/US-0000011')
      p.commit('story', 'sfdx-project.json', 'force-app', 'force-app-service')
      const r = runTravel(p.root, {targetBranch: 'main', targetEnvironment: 'Passport-QA'})
      const file = writeTravelResult(r, p.root)
      const saved = JSON.parse(readFileSync(file, 'utf8')) as TravelResult
      assert.equal(saved.target.environment, 'Passport-QA')
      assert.equal(saved.agents.length, 2)
    } finally {
      p.cleanup()
    }
  })
})
