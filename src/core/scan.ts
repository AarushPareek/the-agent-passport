import {mkdirSync, writeFileSync} from 'node:fs'
import {dirname, isAbsolute, join} from 'node:path'

import {computeFindings} from './findings.ts'
import {buildAgentGraphs} from './graph.ts'
import type {AgentGraph, ScanResult} from './model.ts'
import {loadProject, ProjectError} from './project.ts'

export const TOOL = 'agent-passport@0.1.0'
export const DEFAULT_GRAPH_PATH = join('passport', 'graph.json')

export type ScanOptions = {
  /** Only scan agents whose developer name, bundle folder, or bot name matches (case-insensitive). */
  agent?: string
}

const matches = (graph: AgentGraph, wanted: string): boolean => {
  const w = wanted.toLowerCase()
  return [graph.agent, graph.nodes.find((n) => n.type === 'AiAuthoringBundle' || n.type === 'Bot')?.name].some((name) => name?.toLowerCase() === w)
}

export function runScan(projectRoot: string, options: ScanOptions = {}): ScanResult {
  const project = loadProject(projectRoot)
  let agents = buildAgentGraphs(project)
  if (options.agent) {
    const all = agents
    agents = all.filter((g) => matches(g, options.agent!))
    if (agents.length === 0) {
      const known = all.map((g) => g.agent).join(', ') || 'none'
      throw new ProjectError(`No agent named "${options.agent}" in this project. Agents found: ${known}.`)
    }
  }
  const findings = computeFindings(project, agents)
  const nodes = agents.flatMap((g) => g.nodes)
  return {
    agents,
    findings,
    project: {defaultPackageDir: project.defaultPackageDir, packageDirectories: project.packageDirectories},
    schemaVersion: 1,
    summary: {
      agents: agents.length,
      errors: findings.filter((f) => f.severity === 'error').length,
      infos: findings.filter((f) => f.severity === 'info').length,
      missing: nodes.filter((n) => n.status === 'missing').length,
      standard: nodes.filter((n) => n.status === 'standard').length,
      warnings: findings.filter((f) => f.severity === 'warn').length,
    },
    tool: TOOL,
  }
}

/** Write the result as stable, pretty JSON (no timestamps, so the file only changes when the project does). */
export function writeScanResult(result: ScanResult, projectRoot: string, outPath: string = DEFAULT_GRAPH_PATH): string {
  const target = isAbsolute(outPath) ? outPath : join(projectRoot, outPath)
  mkdirSync(dirname(target), {recursive: true})
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return target
}
