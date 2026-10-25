import type {PluginPipeline} from '@copado/agentia-plugin-sdk'

import {ProjectError} from './project.ts'
import {branchForEnvironment, environmentNames} from './travel.ts'

/** The part of the Agentia host API that looks up pipelines (read-only). */
export type PipelineHost = {
  pipeline: {get(id: string): Promise<PluginPipeline>; list(options: {name?: string; pageSize?: number}): Promise<readonly PluginPipeline[]>}
  project: {current(): Promise<{id?: string; name?: string; pipeline?: {id?: string}}>}
}

const SALESFORCE_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/

/** Find a pipeline by Id or name, or the pipeline of the current Copado project. Errors are ProjectErrors with a way out. */
export async function findPipeline(host: PipelineHost, pipelineFlag?: string): Promise<PluginPipeline> {
  try {
    if (pipelineFlag) {
      if (SALESFORCE_ID.test(pipelineFlag)) return await host.pipeline.get(pipelineFlag)
      const found = (await host.pipeline.list({name: pipelineFlag, pageSize: 50})).find((p) => p.name?.toLowerCase() === pipelineFlag.toLowerCase())
      if (found) return await host.pipeline.get(found.id)
      throw new ProjectError(`No Copado pipeline named "${pipelineFlag}".`)
    }
    const project = await host.project.current()
    if (!project.pipeline?.id) throw new ProjectError(`Copado project "${project.name ?? project.id}" has no pipeline. Pass --pipeline or a target branch.`)
    return await host.pipeline.get(project.pipeline.id)
  } catch (error) {
    if (error instanceof ProjectError) throw error
    throw new ProjectError(`Could not look up the Copado pipeline (${error instanceof Error ? error.message : String(error)}). Pass a target branch (--to-branch / --travel-to-branch) to check offline.`)
  }
}

/** The Git branch of a Copado environment, looked up in the pipeline. */
export async function branchOf(host: PipelineHost, environment: string, pipelineFlag?: string): Promise<string> {
  const pipeline = await findPipeline(host, pipelineFlag)
  const branch = branchForEnvironment(pipeline, environment)
  if (!branch) throw new ProjectError(`Environment "${environment}" is not in pipeline "${pipeline.name ?? pipeline.id}". Environments: ${environmentNames(pipeline).join(', ') || 'none'}.`)
  return branch
}
