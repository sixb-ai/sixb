import type { DatasetDefinition } from "../datasets/types"
import type { DatasetColumnLineage, DatasetColumnRef } from "../lake-storage/types"
import { PipelineError } from "./errors"
import type { PipelineStepDefinition } from "./types"

/**
 * Columns a step reads from one of its inputs: the columns of a `pick()`, otherwise every column of
 * the dataset. Startup checks a pick against the registered dataset, and that any other input is
 * the whole registered dataset.
 */
export function stepInputColumns(input: DatasetDefinition): readonly string[] {
  return input.schema.columns.map((column) => column.name)
}

/**
 * Lineage of a version written by a `run` step. Sixb cannot see what the handler computes, so
 * every output column depends on every column the step reads.
 */
export function runStepLineage(
  step: PipelineStepDefinition,
  registeredDatasetsById: ReadonlyMap<string, DatasetDefinition>
): DatasetColumnLineage {
  const output = registeredDatasetsById.get(step.output.id)
  if (!output) {
    throw new PipelineError(
      `[Sixb] Pipeline step '${step.id}' outputs unregistered dataset '${step.output.id}'.`
    )
  }

  return {
    rows: stepReadColumns(step),
    columns: Object.fromEntries(output.schema.columns.map((column) => [column.name, []])),
  }
}

/** Every column a step reads, once each, across all of its inputs. */
export function stepReadColumns(step: PipelineStepDefinition): readonly DatasetColumnRef[] {
  const refs = new Map<string, DatasetColumnRef>()
  for (const input of Object.values(step.inputs)) {
    for (const column of stepInputColumns(input)) {
      refs.set(JSON.stringify([input.id, column]), { datasetId: input.id, column })
    }
  }
  return [...refs.values()]
}
