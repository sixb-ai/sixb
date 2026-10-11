import type {
  DatasetDefinition,
  PipelineDefinition,
  PipelineStepDefinition,
  PipelineStepInput,
  PipelineStepRunContext,
} from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import { isDatasetPick, stepInputColumns } from "@sixb/core/internal/pipelines"
import type {
  DatasetVersion,
  DatasetVersionRef,
  ReadDatasetRowsInput,
} from "@sixb/core/lake-storage"
import { requireRegisteredDataset } from "./errors"
import type { PipelineWorkerContext } from "./types"

export interface ResolvedStepInput {
  readonly name: string
  /** The registered dataset. */
  readonly dataset: DatasetDefinition
  /** Present when the step input is `dataset.pick(...)`: the step reads only those columns. */
  readonly pick?: {
    readonly dataset: DatasetDefinition
    readonly columns: readonly string[]
  }
  readonly version: DatasetVersion
  readonly ref: DatasetVersionRef
}

export async function resolveStepInputs(input: {
  readonly runtime: PipelineWorkerContext
  readonly pipeline: PipelineDefinition
  readonly step: PipelineStepDefinition
  readonly pipelineRunId: string
}): Promise<readonly ResolvedStepInput[]> {
  const { runtime, pipeline, step, pipelineRunId } = input
  const resolved: ResolvedStepInput[] = []

  for (const [name, declaredDataset] of Object.entries(step.inputs)) {
    const dataset = requireRegisteredDataset({
      dataset: runtime.datasets.getById(declaredDataset.id),
      pipelineId: pipeline.id,
      pipelineRunId,
      stepId: step.id,
      role: "input",
      name,
      datasetId: declaredDataset.id,
    })

    const version = await runtime.lakeStorage.getLatestVersion(dataset.id)
    if (!version) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbPipelineWorker] Pipeline '${pipeline.id}' step '${step.id}' input '${name}' dataset '${dataset.id}' has no committed version.`,
        {
          details: {
            pipelineId: pipeline.id,
            pipelineRunId,
            stepId: step.id,
            datasetId: dataset.id,
          },
        }
      )
    }

    resolved.push({
      name,
      dataset,
      ...(isDatasetPick(declaredDataset)
        ? { pick: { dataset: declaredDataset, columns: stepInputColumns(declaredDataset) } }
        : {}),
      version,
      ref: {
        datasetId: version.datasetId,
        versionId: version.versionId,
      },
    })
  }

  return resolved
}

export function createStepInputs(input: {
  readonly lakeStorage: PipelineWorkerContext["lakeStorage"]
  readonly pipeline: PipelineDefinition
  readonly step: PipelineStepDefinition
  readonly resolvedInputs: readonly ResolvedStepInput[]
  readonly signal: AbortSignal
}): PipelineStepRunContext["inputs"] {
  const { lakeStorage, signal } = input
  const inputs: Record<string, PipelineStepInput> = {}

  for (const resolved of input.resolvedInputs) {
    const subject = `[SixbPipelineWorker] Pipeline '${input.pipeline.id}' step '${input.step.id}' input '${resolved.name}'`
    const { pick } = resolved

    inputs[resolved.name] = {
      dataset: pick?.dataset ?? resolved.dataset,
      version: resolved.version,
      readRows(readInput: Omit<ReadDatasetRowsInput, "datasetId" | "versionId"> = {}) {
        // Step readers stay pinned even if newer versions commit while the handler runs.
        return lakeStorage.readRows({
          ...readInput,
          ...(pick && { columns: readPickedColumns(subject, pick.columns, readInput.columns) }),
          signal: readInput.signal ? AbortSignal.any([signal, readInput.signal]) : signal,
          datasetId: resolved.dataset.id,
          versionId: resolved.version.versionId,
        })
      },
    }
  }

  return inputs
}

/**
 * The version records that the step read only the picked columns, which keeps the markings of the
 * others out of its output. Reading another column would make that record false.
 */
function readPickedColumns(
  subject: string,
  pickedColumns: readonly string[],
  requested: readonly string[] | undefined
): readonly string[] {
  // Lake providers read every column for an empty list.
  if (requested === undefined || requested.length === 0) return pickedColumns

  const unpicked = requested.find((column) => !pickedColumns.includes(column))
  if (unpicked !== undefined) {
    throw new Error(
      `${subject} reads column '${unpicked}', which its pick leaves out. Add '${unpicked}' to the pick to read it.`
    )
  }

  return requested
}
