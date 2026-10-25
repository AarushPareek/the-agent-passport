/**
 * Minimal reader for Agent Script (`.agent` files in an AiAuthoringBundle).
 * It extracts only what the dependency graph needs: config, the agent user, subagent blocks, the actions each block
 * defines with their `target: "scheme://Name"`, and `@utils.transition to @subagent.x` routing.
 * It is not a full parser: `sf agent validate authoring-bundle` stays the authority on whether a script compiles.
 */

export type ScriptTarget = {name: string; raw: string; scheme: string}

export type ScriptAction = {line: number; name: string; target?: ScriptTarget}

export type ScriptBlock = {
  actions: ScriptAction[]
  kind: 'start_agent' | 'subagent'
  line: number
  name: string
  /** Names of subagents this block can route to. */
  transitions: string[]
}

export type AgentScript = {
  agentLabel?: string
  agentType?: string
  blocks: ScriptBlock[]
  defaultAgentUser?: string
  developerName?: string
}

const BLOCK_HEADER = /^(start_agent|subagent|topic)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/
const QUOTED = /^"((?:[^"\\]|\\.)*)"/
const TARGET = /^([A-Za-z][A-Za-z0-9]*):\/\/(\S+)$/
// Two forms: a reasoning tool (`name: @utils.transition to @subagent.x`) and a direct statement in procedural
// instructions (`transition to @subagent.x`). Both route the conversation to another subagent.
const TRANSITION = /(?:@utils\.)?\btransition\s+to\s+@(?:subagent|topic)\.([A-Za-z_][A-Za-z0-9_]*)/g

const indentOf = (line: string): number => {
  let n = 0
  for (const ch of line) {
    if (ch === ' ') n += 1
    else if (ch === '\t') n += 4
    else break
  }
  return n
}

const unquote = (value: string): string | undefined => {
  const m = value.trim().match(QUOTED)
  return m ? m[1] : undefined
}

export function parseAgentScript(text: string): AgentScript {
  const script: AgentScript = {blocks: []}
  let section: string | undefined // top-level section name, e.g. config, access, variables
  let block: ScriptBlock | undefined
  // Open keys inside the current block, from outermost to innermost.
  let stack: Array<{indent: number; key: string; value: string}> = []
  // Inside a `key:|` text block, every more-indented line is prose, not structure.
  let textBlockIndent: number | undefined

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('|')) continue
    const indent = indentOf(line)
    if (textBlockIndent !== undefined) {
      if (indent > textBlockIndent) continue
      textBlockIndent = undefined
    }

    if (indent === 0) {
      const header = trimmed.match(BLOCK_HEADER)
      if (header) {
        block = {actions: [], kind: header[1] === 'start_agent' ? 'start_agent' : 'subagent', line: i + 1, name: header[2], transitions: []}
        script.blocks.push(block)
        section = undefined
      } else {
        block = undefined
        section = trimmed.match(KEY_LINE)?.[1]
      }
      stack = []
      continue
    }

    if (!block) {
      const kv = trimmed.match(KEY_LINE)
      if (!kv) continue
      const value = unquote(kv[2])
      if (value === undefined) continue
      // The agent user may sit in `access:` or directly in `config:`; both forms appear in Salesforce's samples.
      if (kv[1] === 'default_agent_user' && (section === 'access' || section === 'config')) script.defaultAgentUser = value
      else if (section === 'config') {
        if (kv[1] === 'developer_name') script.developerName = value
        else if (kv[1] === 'agent_label') script.agentLabel = value
        else if (kv[1] === 'agent_type') script.agentType = value
      }
      continue
    }

    for (const m of trimmed.matchAll(TRANSITION)) {
      if (!block.transitions.includes(m[1])) block.transitions.push(m[1])
    }

    const kv = trimmed.match(KEY_LINE)
    if (!kv) continue
    while (stack.length > 0 && stack.at(-1)!.indent >= indent) stack.pop()
    const [, key, rest] = kv
    const parent = stack.at(-1)

    // `actions:` > `<name>:` with nothing after the colon defines an action. (`<name>: @utils.transition ...` is a reasoning tool, not an action.)
    if (parent?.key === 'actions' && rest.trim() === '' && !block.actions.some((a) => a.name === key)) {
      block.actions.push({line: i + 1, name: key})
    }

    if (key === 'target') {
      let owner: (typeof stack)[number] | undefined
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s - 1].key === 'actions') {
          owner = stack[s]
          break
        }
      }
      const raw = unquote(rest)
      const action = owner ? block.actions.find((a) => a.name === owner.key) : undefined
      if (action && raw !== undefined) {
        const t = raw.match(TARGET)
        action.target = t ? {name: t[2], raw, scheme: t[1]} : {name: raw, raw, scheme: ''}
      }
    }

    stack.push({indent, key, value: rest})
    if (rest.trim() === '|') textBlockIndent = indent
  }
  return script
}
