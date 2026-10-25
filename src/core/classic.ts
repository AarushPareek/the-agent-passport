/**
 * Readers for the classic Agentforce metadata chain:
 * Bot -> BotVersion -> GenAiPlannerBundle -> GenAiPlugin (topic) -> GenAiFunction (action) -> Apex / Flow / prompt template.
 * The files are plain Salesforce metadata XML; we only need a handful of tags, so a tag reader is enough.
 */

const decode = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

/** Text of every `<tag>...</tag>` (any depth, attributes allowed, values trimmed). */
export function xmlValues(xml: string, tag: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?\\s*>([\\s\\S]*?)</${tag}>`, 'g')
  for (const m of xml.matchAll(re)) out.push(decode(m[1].trim()))
  return out
}

const first = (xml: string, tag: string): string | undefined => xmlValues(xml, tag)[0]
const unique = (values: string[]): string[] => [...new Set(values.filter((v) => v.length > 0))]

export type ClassicBot = {agentType?: string; botUser?: string; label?: string; type?: string}

export function parseBot(xml: string): ClassicBot {
  const domain = first(xml, 'botMlDomain')
  return {
    agentType: first(xml, 'agentType'),
    botUser: first(xml, 'botUser'),
    label: (domain && first(domain, 'label')) ?? first(xml, 'label'),
    type: first(xml, 'type'),
  }
}

/** Planner names a bot version points at. */
export function parseBotVersion(xml: string): {planners: string[]} {
  return {planners: unique(xmlValues(xml, 'genAiPlannerName'))}
}

/** Topics (plugins) and actions (functions) a planner bundle uses, including actions on customised topics. */
export function parsePlannerBundle(xml: string): {functions: string[]; plugins: string[]} {
  return {
    functions: unique([...xmlValues(xml, 'genAiFunctionName'), ...xmlValues(xml, 'functionName')]),
    plugins: unique(xmlValues(xml, 'genAiPluginName')),
  }
}

/** Actions a topic (plugin) uses. */
export function parsePlugin(xml: string): {functions: string[]} {
  return {functions: unique([...xmlValues(xml, 'functionName'), ...xmlValues(xml, 'genAiFunctionName')])}
}

/** What an action (function) runs: `invocationTargetType` is apex, flow, generatePromptResponse, standardInvocableAction, ... */
export function parseFunction(xml: string): {target?: string; targetType?: string} {
  return {target: first(xml, 'invocationTarget'), targetType: first(xml, 'invocationTargetType')}
}

/** Data a prompt template pulls in, from `templateDataProviders`: `apex://X`, `flow://X`, `SOBJECT://X`, `invocable://X`. */
export function parsePromptTemplate(xml: string): {references: Array<{name: string; scheme: string}>} {
  const references: Array<{name: string; scheme: string}> = []
  for (const value of xmlValues(xml, 'definition')) {
    const m = value.match(/^([A-Za-z]+):\/\/(.+)$/)
    if (m && !references.some((r) => r.scheme === m[1] && r.name === m[2])) references.push({name: m[2], scheme: m[1]})
  }
  return {references}
}
