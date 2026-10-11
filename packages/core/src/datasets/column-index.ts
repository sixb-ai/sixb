import type { DatasetColumnDefinition, DatasetDefinition } from "./types"

const indexes = new WeakMap<DatasetDefinition, ReadonlyMap<string, DatasetColumnDefinition>>()

/**
 * The columns of a dataset definition by name, built once per definition object. Registered
 * definitions are not changed after startup, so every check and resolver can share one index.
 */
export function columnsByName(
  dataset: DatasetDefinition
): ReadonlyMap<string, DatasetColumnDefinition> {
  let index = indexes.get(dataset)
  if (!index) {
    index = new Map(dataset.schema.columns.map((column) => [column.name, column]))
    indexes.set(dataset, index)
  }

  return index
}
