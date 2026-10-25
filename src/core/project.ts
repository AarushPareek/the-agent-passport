import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs'
import {join, relative, sep} from 'node:path'

import type {ComponentType, Location, PackageDirectory} from './model.ts'

/** A string replacement from `sfdx-project.json`, applied by the Salesforce CLI at deploy time. */
export type Replacement = {filename?: string; glob?: string; stringToReplace?: string}

export type ProjectIndex = {
  /** Every indexed component, keyed by `Type:name` in lower case (Salesforce API names are case-insensitive). */
  components: Map<string, {locations: Location[]; name: string; type: ComponentType}>
  defaultPackageDir: string
  packageDirectories: PackageDirectory[]
  replacements: Replacement[]
  root: string
}

export class ProjectError extends Error {}

const SKIP_DIRS = new Set(['.git', '.sf', '.sfdx', 'node_modules'])

/** Recognise a metadata file from its path (source format). Returns undefined for files we don't index. */
export function classifyPath(posixPath: string): {name: string; type: ComponentType} | undefined {
  const parts = posixPath.split('/')
  const file = parts.at(-1) ?? ''
  const parent = parts.at(-2) ?? ''
  const grandparent = parts.at(-3) ?? ''
  let m: RegExpMatchArray | null
  if (parent === 'classes' && (m = file.match(/^(.+)\.cls$/))) return {name: m[1], type: 'ApexClass'}
  if (parent === 'flows' && (m = file.match(/^(.+)\.flow-meta\.xml$/))) return {name: m[1], type: 'Flow'}
  if (parent === 'genAiPromptTemplates' && (m = file.match(/^(.+)\.genAiPromptTemplate-meta\.xml$/))) return {name: m[1], type: 'GenAiPromptTemplate'}
  if (parent === 'genAiPlugins' && (m = file.match(/^(.+)\.genAiPlugin-meta\.xml$/))) return {name: m[1], type: 'GenAiPlugin'}
  if (grandparent === 'genAiFunctions' && (m = file.match(/^(.+)\.genAiFunction-meta\.xml$/)) && m[1] === parent) return {name: m[1], type: 'GenAiFunction'}
  if (grandparent === 'genAiPlannerBundles' && (m = file.match(/^(.+)\.genAiPlannerBundle$/)) && m[1] === parent) return {name: m[1], type: 'GenAiPlannerBundle'}
  if (grandparent === 'aiAuthoringBundles' && (m = file.match(/^(.+)\.agent$/)) && m[1] === parent) return {name: m[1], type: 'AiAuthoringBundle'}
  if (grandparent === 'bots' && (m = file.match(/^(.+)\.bot-meta\.xml$/)) && m[1] === parent) return {name: m[1], type: 'Bot'}
  if (grandparent === 'bots' && (m = file.match(/^(.+)\.botVersion-meta\.xml$/))) return {name: `${parent}.${m[1]}`, type: 'BotVersion'}
  if (grandparent === 'objects' && (m = file.match(/^(.+)\.object-meta\.xml$/)) && m[1] === parent) return {name: m[1], type: 'CustomObject'}
  return undefined
}

/**
 * The component a file belongs to, including sidecar and bundle files: `Foo.cls-meta.xml` belongs to ApexClass Foo,
 * `genAiFunctions/X/input/schema.json` to GenAiFunction X, `objects/Obj__c/fields/F__c.field-meta.xml` to CustomObject Obj__c.
 * Used to tell which components a set of changed files touches.
 */
export function ownerComponent(posixPath: string): {name: string; type: ComponentType} | undefined {
  const direct = classifyPath(posixPath)
  if (direct) return direct
  const parts = posixPath.split('/')
  const file = parts.at(-1) ?? ''
  let m: RegExpMatchArray | null
  if (parts.at(-2) === 'classes' && (m = file.match(/^(.+)\.cls-meta\.xml$/))) return {name: m[1], type: 'ApexClass'}
  const folderTypes: Array<[string, ComponentType]> = [
    ['aiAuthoringBundles', 'AiAuthoringBundle'],
    ['genAiFunctions', 'GenAiFunction'],
    ['genAiPlannerBundles', 'GenAiPlannerBundle'],
    ['objects', 'CustomObject'],
  ]
  for (const [folder, type] of folderTypes) {
    const i = parts.lastIndexOf(folder)
    if (i !== -1 && i + 2 < parts.length) return {name: parts[i + 1], type}
  }
  return undefined
}

export const componentKey = (type: ComponentType, name: string): string => `${type}:${name}`.toLowerCase()

export const toPosix = (path: string): string => path.split(sep).join('/')

function walk(dir: string, onFile: (absolutePath: string) => void): void {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), onFile)
    } else if (entry.isFile()) {
      onFile(join(dir, entry.name))
    }
  }
}

/** Read `sfdx-project.json` and index every recognised metadata file in every package directory. */
export function loadProject(root: string): ProjectIndex {
  const projectFile = join(root, 'sfdx-project.json')
  if (!existsSync(projectFile)) throw new ProjectError(`No sfdx-project.json in ${root}. Run this from a Salesforce DX project, or pass --project-dir.`)
  let raw: {packageDirectories?: Array<{default?: boolean; path?: string}>; replacements?: Replacement[]}
  try {
    raw = JSON.parse(readFileSync(projectFile, 'utf8'))
  } catch (error) {
    throw new ProjectError(`sfdx-project.json is not valid JSON: ${(error as Error).message}`)
  }
  const dirs = (raw.packageDirectories ?? []).filter((d): d is {default?: boolean; path: string} => typeof d.path === 'string')
  if (dirs.length === 0) throw new ProjectError('sfdx-project.json has no packageDirectories.')
  const packageDirectories: PackageDirectory[] = dirs.map((d) => ({default: d.default === true, path: toPosix(d.path).replace(/\/$/, '')}))
  // The Salesforce CLI treats the directory marked default: true as default, or the first one when none is marked.
  const defaultPackageDir = (packageDirectories.find((d) => d.default) ?? packageDirectories[0]).path

  const components: ProjectIndex['components'] = new Map()
  for (const pkg of packageDirectories) {
    const absolute = join(root, pkg.path)
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) continue
    walk(absolute, (file) => {
      const path = toPosix(relative(root, file))
      const hit = classifyPath(path)
      if (!hit) return
      const key = componentKey(hit.type, hit.name)
      const entry = components.get(key) ?? {locations: [], name: hit.name, type: hit.type}
      entry.locations.push({packageDir: pkg.path, path})
      components.set(key, entry)
    })
  }
  return {components, defaultPackageDir, packageDirectories, replacements: Array.isArray(raw.replacements) ? raw.replacements : [], root}
}

export function findComponent(project: ProjectIndex, type: ComponentType, name: string) {
  return project.components.get(componentKey(type, name))
}

export function readProjectFile(project: ProjectIndex, location: Location): string {
  return readFileSync(join(project.root, ...location.path.split('/')), 'utf8')
}

export function listComponents(project: ProjectIndex, type: ComponentType) {
  return [...project.components.values()].filter((c) => c.type === type).sort((a, b) => a.name.localeCompare(b.name))
}

function globToRegExp(glob: string): RegExp {
  let pattern = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*') {
      pattern += '.*'
      i++
      if (glob[i + 1] === '/') i++
    } else if (ch === '*') pattern += '[^/]*'
    else if (ch === '?') pattern += '[^/]'
    else pattern += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${pattern}$`)
}

/** Does a `replacements` entry in sfdx-project.json rewrite `token` in this file at deploy time? */
export function replacementCovers(project: ProjectIndex, posixPath: string, token: string): boolean {
  return project.replacements.some((r) => {
    if (typeof r.stringToReplace !== 'string' || !token.includes(r.stringToReplace)) return false
    if (typeof r.filename === 'string') return toPosix(r.filename) === posixPath
    if (typeof r.glob === 'string') return globToRegExp(toPosix(r.glob)).test(posixPath)
    return false
  })
}
