import type {
  DatasetDefinition,
  DatasetRow,
  DatasetVersion,
  PipelineDefinition,
  PipelineStepDefinition,
  PipelineStepRunContext,
} from "@sixb/core"
import { PipelineWorkerError, throwIfAborted } from "./errors"
import { createStepInputs, type ResolvedStepInput } from "./step-inputs"
import type { PipelineJob, PipelineLogSession, PipelineWorkerContext } from "./types"

export async function executeRunStep(input: {
  readonly runtime: PipelineWorkerContext
  readonly pipeline: PipelineDefinition
  readonly step: PipelineStepDefinition
  readonly job: PipelineJob
  readonly signal: AbortSignal
  readonly logSession: PipelineLogSession
  readonly outputDataset: DatasetDefinition
  readonly resolvedInputs: readonly ResolvedStepInput[]
}): Promise<{ readonly version: DatasetVersion; readonly rowsWritten: number }> {
  const { runtime, pipeline, step, job, signal, outputDataset, resolvedInputs } = input

  if (step.executor.kind !== "run") {
    throw new PipelineWorkerError(
      `[SixbPipelineWorker] Pipeline '${pipeline.id}' step '${step.id}' uses SQL execution, which is not supported by the run step executor.`
    )
  }

  const logger = input.logSession.withContext({ stepId: step.id })
  let rowsWritten = 0
  const write = await runtime.lakeStorage.beginWrite({
    dataset: outputDataset,
    mode: step.mode,
    inputs: resolvedInputs.map((resolved) => resolved.ref),
    producer: {
      kind: "pipeline",
      id: pipeline.id,
      runId: job.id,
      stepId: step.id,
    },
  })

  try {
    const context: PipelineStepRunContext = {
      projectId: runtime.id,
      pipelineId: pipeline.id,
      stepId: step.id,
      runId: job.id,
      signal,
      logger,
      inputs: createStepInputs(runtime.lakeStorage, resolvedInputs),
      output: {
        async writeRows(rows) {
          await write.writeRows(
            countRowsWritten(rows, signal, () => {
              rowsWritten += 1
            })
          )
        },
      },
    }

    await step.executor.handler(context)
    throwIfAborted(signal)

    const version = await write.commit({
      commitMessage: `pipeline ${pipeline.id} step ${step.id} run ${job.id}`,
    })

    return {
      version,
      rowsWritten,
    }
  } catch (error) {
    await write.abort().catch(() => {})
    throw error
  }
}

async function* countRowsWritten(
  rows: Iterable<DatasetRow> | AsyncIterable<DatasetRow>,
  signal: AbortSignal,
  onWritten: () => void
): AsyncIterable<DatasetRow> {
  for await (const row of rows) {
    throwIfAborted(signal)
    yield row
    onWritten()
  }
}
