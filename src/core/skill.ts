import {existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join, relative} from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * The Agent Passport Agent Skill: Markdown that teaches a coding agent (Claude Code, Cursor, Codex...) the Passport
 * workflow. Installed in the same places as Agentia's own skills (`agentia setup skills create --target ...`), so an
 * agent that already loads Agentia's skills finds this one too.
 */

export const SKILL_NAME = 'agent-passport'
export const MANAGED_MARKER = '<!-- Agent Passport managed skill file: agentia passport setup -->'

export const SKILL_TARGETS = {agents: '.agents/skills', claude: '.claude/skills', cursor: '.cursor/skills'} as const
export type SkillTarget = keyof typeof SKILL_TARGETS

/** Shipped with the package: <package>/skills/agent-passport/ (two levels above src/core and dist/core). */
export const SKILL_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', SKILL_NAME)

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, {recursive: true, withFileTypes: true})
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/'))
    .sort()
}

export type SkillChange = {action: 'conflict' | 'created' | 'removed' | 'unchanged' | 'updated'; file: string}

/**
 * Write the skill into each target. Files we wrote before (they carry the managed marker) are refreshed; a file at the
 * same path that someone else wrote is left alone and reported as a conflict, unless `force`.
 */
export function installSkill(projectRoot: string, targets: SkillTarget[], options: {force?: boolean; source?: string} = {}): SkillChange[] {
  const source = options.source ?? SKILL_SOURCE
  const changes: SkillChange[] = []
  for (const target of targets) {
    for (const file of sourceFiles(source)) {
      const rel = `${SKILL_TARGETS[target]}/${SKILL_NAME}/${file}`
      const dest = join(projectRoot, ...rel.split('/'))
      const text = readFileSync(join(source, ...file.split('/')), 'utf8')
      if (!text.includes(MANAGED_MARKER)) throw new Error(`Skill template ${file} is missing the managed marker.`)
      const before = existsSync(dest) ? readFileSync(dest, 'utf8') : undefined
      if (before === text) {
        changes.push({action: 'unchanged', file: rel})
        continue
      }
      if (before !== undefined && !before.includes(MANAGED_MARKER) && !options.force) {
        changes.push({action: 'conflict', file: rel})
        continue
      }
      mkdirSync(dirname(dest), {recursive: true})
      writeFileSync(dest, text, 'utf8')
      changes.push({action: before === undefined ? 'created' : 'updated', file: rel})
    }
  }
  return changes
}

/** Remove only the skill files we manage; files without the marker are kept. Empty folders we leave behind are removed. */
export function removeSkill(projectRoot: string, targets: SkillTarget[]): SkillChange[] {
  const changes: SkillChange[] = []
  for (const target of targets) {
    const root = join(projectRoot, ...SKILL_TARGETS[target].split('/'), SKILL_NAME)
    if (!existsSync(root)) continue
    for (const file of sourceFiles(root)) {
      const path = join(root, ...file.split('/'))
      const rel = `${SKILL_TARGETS[target]}/${SKILL_NAME}/${file}`
      if (readFileSync(path, 'utf8').includes(MANAGED_MARKER)) {
        rmSync(path)
        changes.push({action: 'removed', file: rel})
      } else changes.push({action: 'conflict', file: rel})
    }
    removeEmptyDirs(root)
  }
  return changes
}

function removeEmptyDirs(dir: string): void {
  for (const e of readdirSync(dir, {withFileTypes: true})) if (e.isDirectory()) removeEmptyDirs(join(dir, e.name))
  if (readdirSync(dir).length === 0) rmdirSync(dir)
}
