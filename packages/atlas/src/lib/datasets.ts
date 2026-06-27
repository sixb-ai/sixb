import { humanizeIdentifier } from "./labels"

// Structural shape shared by the catalog list item and the full dataset detail.
type DatasetRefs = {
  syncIds: string[]
  sourcePipelineIds: string[]
  targetPipelineIds: string[]
  projectionIds: string[]
}

export function datasetName(dataset: { id: string }): string {
  return humanizeIdentifier(dataset.id)
}

export function formatCount(value?: number): string {
  return typeof value === "number" ? value.toLocaleString() : "—"
}

export function formatBytes(value?: number): string {
  if (typeof value !== "number") return "—"
  if (value === 0) return "0 B"

  const units = ["B", "KB", "MB", "GB", "TB"]
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const scaled = value / 1024 ** index
  const precision = scaled >= 10 || index === 0 ? 0 : 1

  return `${scaled.toFixed(precision)} ${units[index]}`
}

export function sourceCount(dataset: DatasetRefs): number {
  return dataset.syncIds.length + dataset.sourcePipelineIds.length + dataset.projectionIds.length
}

export function consumerCount(dataset: DatasetRefs): number {
  return dataset.targetPipelineIds.length
}

// Column types the lake schema can declare. Numeric types are right-aligned in
// the grid and get tabular figures.
const numericColumnTypes = new Set(["int64", "float64", "decimal"])

export function isNumericColumnType(type: string): boolean {
  return numericColumnTypes.has(type)
}
