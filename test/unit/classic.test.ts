import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {parseBot, parseBotVersion, parseFunction, parsePlannerBundle, parsePlugin, parsePromptTemplate, xmlValues} from '../../src/core/classic.ts'

describe('xmlValues', () => {
  it('reads values when the closing bracket of the start tag is on the next line (as in Coral Cloud)', () => {
    assert.deepEqual(xmlValues('<GenAiFunction>\n    <invocationTarget\n    >Get_Customer</invocationTarget>\n</GenAiFunction>', 'invocationTarget'), ['Get_Customer'])
  })

  it('decodes XML entities and trims whitespace', () => {
    assert.deepEqual(xmlValues('<label>  Q&amp;A &lt;bot&gt; </label>', 'label'), ['Q&A <bot>'])
  })

  it('does not match a tag that only starts with the same name', () => {
    assert.deepEqual(xmlValues('<functionNameX>a</functionNameX><functionName>b</functionName>', 'functionName'), ['b'])
  })
})

describe('classic metadata readers', () => {
  it('parseBot reads agent type, bot user and label', () => {
    const bot = parseBot(
      '<Bot><agentType>EinsteinServiceAgent</agentType><botMlDomain><label>Coral Cloud Agent</label><name>X</name></botMlDomain><botUser>agent-%%SF_CC_PLACEHOLDER_USERNAME%%</botUser><type>ExternalCopilot</type></Bot>',
    )
    assert.deepEqual(bot, {agentType: 'EinsteinServiceAgent', botUser: 'agent-%%SF_CC_PLACEHOLDER_USERNAME%%', label: 'Coral Cloud Agent', type: 'ExternalCopilot'})
  })

  it('parseBotVersion lists planners once each', () => {
    assert.deepEqual(parseBotVersion('<conversationDefinitionPlanners><genAiPlannerName>P</genAiPlannerName></conversationDefinitionPlanners><genAiPlannerName>P</genAiPlannerName>').planners, ['P'])
  })

  it('parsePlannerBundle lists topics and actions, including actions on customised topics', () => {
    const uses = parsePlannerBundle(
      '<genAiPlugins><genAiPluginName>Topic_A</genAiPluginName></genAiPlugins><genAiFunctions><genAiFunctionName>NS__Answer</genAiFunctionName></genAiFunctions><genAiCustomizedPlugin><functionName>Local_Action</functionName></genAiCustomizedPlugin>',
    )
    assert.deepEqual(uses, {functions: ['NS__Answer', 'Local_Action'], plugins: ['Topic_A']})
  })

  it('parsePlugin lists the actions of a topic, ignoring instruction developer names', () => {
    const plugin = parsePlugin('<genAiFunctions><functionName>Get_Sessions</functionName></genAiFunctions><genAiPluginInstructions><developerName>instruction_1</developerName></genAiPluginInstructions>')
    assert.deepEqual(plugin.functions, ['Get_Sessions'])
  })

  it('parseFunction reads what an action runs', () => {
    assert.deepEqual(parseFunction('<invocationTarget>CheckWeather</invocationTarget><invocationTargetType>apex</invocationTargetType>'), {target: 'CheckWeather', targetType: 'apex'})
  })

  it('parsePromptTemplate lists data providers by scheme, once each', () => {
    const refs = parsePromptTemplate(
      '<templateDataProviders><definition>apex://PersonalizedGuestExperiences</definition></templateDataProviders><inputs><definition>SOBJECT://Session__c</definition></inputs><inputs><definition>primitive://String</definition></inputs><x><definition>apex://PersonalizedGuestExperiences</definition></x>',
    ).references
    assert.deepEqual(refs, [
      {name: 'PersonalizedGuestExperiences', scheme: 'apex'},
      {name: 'Session__c', scheme: 'SOBJECT'},
      {name: 'String', scheme: 'primitive'},
    ])
  })
})
