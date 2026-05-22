import type {
  DatasetDefinition,
  DatasetVersion,
  LakeStorage,
  LakeStorageWithSql,
  PipelineDefinition,
  PipelineStepDefinition,
} from "@pario/core"
import { PipelineWorkerError, throwIfAborted } from "./errors"
import type { ResolvedStepInput } from "./step-inputs"
import type { PipelineJob, PipelineWorkerContext } from "./types"

function hasSqlExecutor(lakeStorage: LakeStorage): lakeStorage is LakeStorageWithSql {
  const sql = "sql" in lakeStorage ? lakeStorage.sql : null

  return (
    typeof sql === "object" && sql !== null && "execute" in sql && typeof sql.execute === "function"
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
}): Promise<{ readonly version: DatasetVersion; readonly rowsWritten?: number }> {
  const { runtime, pipeline, step, job, signal, outputDataset, resolvedInputs } = input

  if (step.executor.kind !== "sql") {
    throw new PipelineWorkerError(
      `[ParioPipelineWorker] Pipeline '${pipeline.id}' step '${step.id}' uses run execution, which is not supported by the SQL step executor.`
    )
  }

  if (!hasSqlExecutor(runtime.lakeStorage)) {
    throw new PipelineWorkerError(
      `[ParioPipelineWorker] Pipeline '${pipeline.id}' step '${step.id}' requires SQL transform support, but lake storage does not provide lakeStorage.sql.execute(...).`
    )
  }

  throwIfAborted(signal)

  const version = await runtime.lakeStorage.sql.execute({
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

  return {
    version,
    rowsWritten: version.rowCount,
  }
}
