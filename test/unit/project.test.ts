import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, it} from 'node:test'

import {classifyPath, findComponent, loadProject, ProjectError, replacementCovers} from '../../src/core/project.ts'
import {fixtureProject} from '../helpers/fixtures.ts'

describe('classifyPath', () => {
  const cases: Array<[string, string | undefined]> = [
    ['force-app/main/default/classes/IssueClassifier.cls', 'ApexClass:IssueClassifier'],
    ['force-app/main/default/classes/IssueClassifier.cls-meta.xml', undefined],
    ['force-app/main/default/flows/CreateCase.flow-meta.xml', 'Flow:CreateCase'],
    ['x/genAiPromptTemplates/Summarize.genAiPromptTemplate-meta.xml', 'GenAiPromptTemplate:Summarize'],
    ['x/genAiPlugins/Topic_A.genAiPlugin-meta.xml', 'GenAiPlugin:Topic_A'],
    ['x/genAiFunctions/Check_Weather/Check_Weather.genAiFunction-meta.xml', 'GenAiFunction:Check_Weather'],
    ['x/genAiFunctions/Check_Weather/input/schema.json', undefined],
    ['x/genAiPlannerBundles/Agent_X/Agent_X.genAiPlannerBundle', 'GenAiPlannerBundle:Agent_X'],
    ['x/aiAuthoringBundles/Helper/Helper.agent', 'AiAuthoringBundle:Helper'],
    ['x/aiAuthoringBundles/Helper/Other.agent', undefined],
    ['x/bots/Agent_X/Agent_X.bot-meta.xml', 'Bot:Agent_X'],
    ['x/bots/Agent_X/v2.botVersion-meta.xml', 'BotVersion:Agent_X.v2'],
    ['x/objects/Session__c/Session__c.object-meta.xml', 'CustomObject:Session__c'],
    ['x/objects/Contact/fields/Tier__c.field-meta.xml', undefined],
  ]
  for (const [path, expected] of cases) {
    it(`${path} -> ${expected ?? 'not indexed'}`, () => {
      const hit = classifyPath(path)
      assert.equal(hit ? `${hit.type}:${hit.name}` : undefined, expected)
    })
  }
})

describe('loadProject', () => {
  it('uses the package directory marked default', () => {
    const p = loadProject(fixtureProject('agent-script-recipes'))
    assert.equal(p.defaultPackageDir, 'force-app')
    assert.deepEqual(
      p.packageDirectories.map((d) => d.path),
      ['force-app', 'force-app-service'],
    )
  })

  it('records every location of a component that exists twice', () => {
    const p = loadProject(fixtureProject('agent-script-recipes'))
    assert.deepEqual(
      findComponent(p, 'Flow', 'CreateCase')?.locations.map((l) => l.packageDir),
      ['force-app', 'force-app-service'],
    )
  })

  it('finds components case-insensitively, like Salesforce does', () => {
    const p = loadProject(fixtureProject('agent-script-recipes'))
    assert.equal(findComponent(p, 'ApexClass', 'issueclassifier')?.name, 'IssueClassifier')
  })

  it('falls back to the first package directory when none is marked default', () => {
    const root = mkdtempSync(join(tmpdir(), 'passport-proj-'))
    try {
      writeFileSync(join(root, 'sfdx-project.json'), JSON.stringify({packageDirectories: [{path: 'one'}, {path: 'two'}]}))
      mkdirSync(join(root, 'one'))
      assert.equal(loadProject(root).defaultPackageDir, 'one')
    } finally {
      rmSync(root, {force: true, recursive: true})
    }
  })

  it('explains a missing or broken sfdx-project.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'passport-proj-'))
    try {
      assert.throws(() => loadProject(root), (e: unknown) => e instanceof ProjectError && /No sfdx-project\.json/.test(e.message))
      writeFileSync(join(root, 'sfdx-project.json'), '{ not json')
      assert.throws(() => loadProject(root), (e: unknown) => e instanceof ProjectError && /not valid JSON/.test(e.message))
      writeFileSync(join(root, 'sfdx-project.json'), '{"packageDirectories": []}')
      assert.throws(() => loadProject(root), (e: unknown) => e instanceof ProjectError && /no packageDirectories/.test(e.message))
    } finally {
      rmSync(root, {force: true, recursive: true})
    }
  })
})

describe('replacementCovers', () => {
  it('matches a filename replacement for the right token (Coral Cloud)', () => {
    const p = loadProject(fixtureProject('coral-cloud'))
    const bot = 'cc-service-app/main/default/bots/Coral_Cloud_Agent/Coral_Cloud_Agent.bot-meta.xml'
    assert.equal(replacementCovers(p, bot, '%%SF_CC_PLACEHOLDER_USERNAME%%'), true)
    assert.equal(replacementCovers(p, bot, '%%SOMETHING_ELSE%%'), false)
    assert.equal(replacementCovers(p, 'cc-service-app/main/default/bots/Other/Other.bot-meta.xml', '%%SF_CC_PLACEHOLDER_USERNAME%%'), false)
  })

  it('matches a glob replacement', () => {
    const p = loadProject(fixtureProject('coral-cloud'))
    assert.equal(replacementCovers(p, 'cc-service-app/main/default/networks/site.network-meta.xml', '%%SF_CC_PLACEHOLDER_USERNAME%%'), true)
    assert.equal(replacementCovers(p, 'cc-service-app/networks/site.network-meta.xml', '%%SF_CC_PLACEHOLDER_USERNAME%%'), true)
    assert.equal(replacementCovers(p, 'cc-base-app/main/default/networks/site.network-meta.xml', '%%SF_CC_PLACEHOLDER_USERNAME%%'), false)
  })
})
