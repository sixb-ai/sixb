import type {
  DatasetDefinition,
  DatasetVersion,
  DatasetVersionRef,
  PipelineDefinition,
  PipelineStepDefinition,
  PipelineStepInput,
  PipelineStepRunContext,
  ReadDatasetRowsInput,
} from "@sixb/core"
import { PipelineWorkerError, requireRegisteredDataset } from "./errors"
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
}): Promise<readonly ResolvedStepInput[]> {
  const { runtime, pipeline, step } = input
  const resolved: ResolvedStepInput[] = []

  for (const [name, declaredDataset] of Object.entries(step.inputs)) {
    const dataset = requireRegisteredDataset({
      dataset: runtime.getDatasetById(declaredDataset.id),
      pipelineId: pipeline.id,
      stepId: step.id,
      role: "input",
      name,
      datasetId: declaredDataset.id,
    })

    const version = await runtime.lakeStorage.getLatestVersion(dataset.id)
    if (!version) {
      throw new PipelineWorkerError(
        `[SixbPipelineWorker] Pipeline '${pipeline.id}' step '${step.id}' input '${name}' dataset '${dataset.id}' has no committed version.`
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
