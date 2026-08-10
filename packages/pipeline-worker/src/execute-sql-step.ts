import type {
  DatasetDefinition,
  LakeStorage,
  LakeStorageWithSql,
  PipelineDefinition,
  PipelineStepDefinition,
} from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import type {
  DatasetVersion,
  DatasetWriteMode,
  LakeSqlTransformCapabilities,
} from "@sixb/core/lake-storage"
import { throwIfAborted } from "./errors"
import type { ResolvedStepInput } from "./step-inputs"
import type { PipelineJob, PipelineWorkerContext } from "./types"

function hasSqlExecutor(lakeStorage: LakeStorage): lakeStorage is LakeStorageWithSql {
  const sql = "sql" in lakeStorage ? lakeStorage.sql : null

  return (
    typeof sql === "object" && sql !== null && "execute" in sql && typeof sql.execute === "function"
  )
}

function assertSqlModeSupported(input: {
  readonly capabilities: LakeSqlTransformCapabilities
  readonly dialect: string
  readonly mode: DatasetWriteMode
  readonly pipelineId: string
  readonly pipelineRunId: string
  readonly stepId: string
  readonly datasetId: string
}): void {
  const supported =
    input.mode === "append"
      ? input.capabilities.supportsAppend
      : input.capabilities.supportsSnapshot
  if (supported) return

  throw createSixbError(
    "internal.unexpected",
    `[SixbPipelineWorker] Pipeline '${input.pipelineId}' step '${input.stepId}' writes in ` +
      `'${input.mode}' mode, which the ${input.dialect} SQL executor does not support.`,
    {
      details: {
        pipelineId: input.pipelineId,
        pipelineRunId: input.pipelineRunId,
        stepId: input.stepId,
        datasetId: input.datasetId,
      },
    }
  )
}

export async function executeSqlStep(input: {
  readonly runtime: PipelineWorkerContext
  readonly pipeline: PipelineDefinition
  readonly step: PipelineStepDefinition
  readonly job: PipelineJob
  readonly signal: AbortSignal
  readonly outputDataset: DatasetDefinition
  readonly resolvedInputs: readonly ResolvedStepInput[]
}): Promise<{
  readonly version: DatasetVersion
  readonly versionCreated: boolean
  readonly rowsWritten?: number
}> {
  const { runtime, pipeline, step, job, signal, outputDataset, resolvedInputs } = input

  if (step.executor.kind !== "sql") {
    throw createSixbError(
      "internal.unexpected",
      `[SixbPipelineWorker] Pipeline '${pipeline.id}' step '${step.id}' uses run execution, which is not supported by the SQL step executor.`,
      {
        details: {
          pipelineId: pipeline.id,
          pipelineRunId: job.id,
          stepId: step.id,
          datasetId: outputDataset.id,
        },
      }
    )
  }

  if (!hasSqlExecutor(runtime.lakeStorage)) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbPipelineWorker] Pipeline '${pipeline.id}' step '${step.id}' requires SQL transform support, but lake storage does not provide lakeStorage.sql.execute(...).`,
      {
        details: {
          pipelineId: pipeline.id,
          pipelineRunId: job.id,
          stepId: step.id,
          datasetId: outputDataset.id,
        },
      }
    )
  }

  // `LakeSqlExecutor.capabilities` is a required field on the contract that nothing read,
  // so a provider declaring `supportsAppend: false` was asked to be honest and then
  // ignored — the unsupported mode failed somewhere inside the provider instead, in
  // whatever words that provider happened to use.
  assertSqlModeSupported({
    capabilities: runtime.lakeStorage.sql.capabilities,
    dialect: runtime.lakeStorage.sql.dialect,
    mode: step.mode,
    pipelineId: pipeline.id,
    pipelineRunId: job.id,
    stepId: step.id,
    datasetId: outputDataset.id,
  })

  throwIfAborted(signal)

  const commit = await runtime.lakeStorage.sql.execute({
    sources: Object.fromEntries(
      resolvedInputs.map((input) => [
        input.name,
        {
          dataset: input.dataset,
          versionId: input.version.versionId,
        },
      ])
    ),
    sql: step.executor.sql,
    target: outputDataset,
    mode: step.mode,
    producer: {
      kind: "pipeline",
      id: pipeline.id,
      runId: job.id,
      stepId: step.id,
    },
    commitMessage: `pipeline ${pipeline.id} step ${step.id} run ${job.id}`,
  })

  throwIfAborted(signal)
  const { outcome, ...version } = commit

  return {
    version,
    versionCreated: outcome === "created",
    rowsWritten: version.rowCount,
  }
}
