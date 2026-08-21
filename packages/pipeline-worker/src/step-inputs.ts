import type {
  DatasetDefinition,
  PipelineDefinition,
  PipelineStepDefinition,
  PipelineStepInput,
  PipelineStepRunContext,
} from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import type {
  DatasetVersion,
  DatasetVersionRef,
  ReadDatasetRowsInput,
} from "@sixb/core/lake-storage"
import { requireRegisteredDataset } from "./errors"
import type { PipelineWorkerContext } from "./types"

export interface ResolvedStepInput {
  readonly name: string
  readonly dataset: DatasetDefinition
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
      version,
      ref: {
        datasetId: version.datasetId,
        versionId: version.versionId,
      },
    })
  }

  return resolved
}

export function createStepInputs(
  lakeStorage: PipelineWorkerContext["lakeStorage"],
  resolved: readonly ResolvedStepInput[]
): PipelineStepRunContext["inputs"] {
  const inputs: Record<string, PipelineStepInput> = {}

  for (const input of resolved) {
    inputs[input.name] = {
      dataset: input.dataset,
      version: input.version,
      readRows(readInput: Omit<ReadDatasetRowsInput, "datasetId" | "versionId"> = {}) {
        // Step readers stay pinned even if newer versions commit while the handler runs.
        return lakeStorage.readRows({
          ...readInput,
          datasetId: input.dataset.id,
          versionId: input.version.versionId,
        })
      },
    }
  }

  return inputs
}
