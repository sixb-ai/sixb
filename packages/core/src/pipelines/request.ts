import { randomUUID } from "node:crypto"
import { assertAuthorized } from "../authorization"
import { SixbError } from "../errors"
import type { SixbRuntimeContext } from "../runtime/types"
import type { PipelineDefinition } from "./types"

export interface PipelineRunRequestOptions {
  /**
   * Identity of the run to create. Deduplicated when a worker claims the job, not here: two requests
   * carrying the same id enqueue two jobs, and the second loses to the unique run id. So one run
   * happens, but this call cannot tell you whether it was yours.
   */
  readonly runId?: string
}

export interface RequestPipelineRunInput extends PipelineRunRequestOptions {
  readonly pipelineId: string
}

export interface PipelineRunRequestResult {
  readonly pipelineId: string
  readonly runId: string
  /** When the job was enqueued. Not persisted — the run row records `startedAt` instead. */
  readonly queuedAt: string
  readonly jobId?: string
}

/**
 * Authorize and queue a pipeline run request.
 *
 * Operates on an already-resolved definition and the shared runtime context, so the HTTP route and
 * the runtime verb cannot drift apart.
 *
 * Like `requestSyncRun` and unlike `requestWorkflowRun`, the run row is created by the worker that
 * claims the job — see the note there for why the two cannot be aligned by adding a field.
 */
export async function requestPipelineRun(
  runtime: SixbRuntimeContext,
  pipeline: PipelineDefinition,
  options: PipelineRunRequestOptions = {}
): Promise<PipelineRunRequestResult> {
  assertAuthorized(runtime, { kind: "pipeline.run", pipelineId: pipeline.id })
  if (!runtime.storage.pipelineRuns) {
    throw new SixbError("runtime.not_configured", "[Sixb] Pipeline run storage is not configured.")
  }

  const queue = runtime.queues.pipelines
  if (!queue) {
    throw new SixbError("runtime.not_configured", "[Sixb] Pipeline run queue is not configured.")
  }

  const runId = createPipelineRunId(options.runId)
  const queuedAt = new Date().toISOString()
  const [job] = await queue.enqueue({
    projectId: runtime.projectId,
    jobs: [{ type: "pipeline.run.requested", payload: { pipelineId: pipeline.id, runId } }],
  })

  return { pipelineId: pipeline.id, runId, queuedAt, jobId: job?.id }
}

function createPipelineRunId(runId: string | undefined): string {
  if (runId !== undefined) {
    if (!runId.trim()) {
      throw new SixbError("runtime.invalid_definition", "[Sixb] Pipeline run id must not be empty")
    }
    return runId
  }

  return `run_${randomUUID()}`
}
