import { assertAuthorized } from "../authorization"
import {
  createPrimitiveExecutionRecord,
  ensureExecutionRecord,
  executionRecordInputFromRuntime,
} from "../execution/durable"
import type { ExecutionContext } from "../execution/types"
import type { SixbRuntimeContext } from "../runtime/types"
import { PipelineError } from "./errors"
import { dispatchPipelineRun } from "./run-dispatch"
import type { PipelineDefinition } from "./types"

export interface PipelineRunRequestOptions {
  /** Stable identity used to make dispatch idempotent. */
  readonly runId?: string
}

export interface RequestPipelineRunInput extends PipelineRunRequestOptions {
  readonly pipelineId: string
}

export interface PipelineRunRequestResult {
  readonly pipelineId: string
  readonly runId: string
  /** Durable time at which the run entered the queue. */
  readonly queuedAt: string
  readonly jobId?: string
  readonly created: boolean
}

/**
 * Authorize and queue a pipeline run request.
 *
 * Operates on an already-resolved definition and the shared runtime context, so the HTTP route and
 * the runtime verb cannot drift apart.
 *
 * The immutable child execution and queued run are persisted before queue publication.
 */
export async function requestPipelineRun(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  pipeline: PipelineDefinition,
  options: PipelineRunRequestOptions = {}
): Promise<PipelineRunRequestResult> {
  assertAuthorized(runtime, { kind: "pipeline.run", pipelineId: pipeline.id })
  if (!runtime.storage.pipelineRuns) {
    throw new PipelineError("[Sixb] Pipeline run storage is not configured.")
  }

  const queue = runtime.queues.pipelines
  if (!queue) {
    throw new PipelineError("[Sixb] Pipeline run queue is not configured.")
  }

  return dispatchPipelineRun({
    errorReporterHost: runtime,
    projectId: runtime.projectId,
    pipeline,
    storage: runtime.storage,
    queue,
    ...options,
    createExecution: async (executionId, runId) => {
      const caller = await ensureExecutionRecord(
        runtime.storage.executions,
        executionRecordInputFromRuntime({
          execution,
          runtimeAuthorization: runtime.runtimeAuthorization,
        })
      )
      return createPrimitiveExecutionRecord({
        id: executionId,
        primitive: { kind: "pipeline", id: pipeline.id, runId },
        origin: { type: "execution", parent: caller },
      })
    },
  })
}
