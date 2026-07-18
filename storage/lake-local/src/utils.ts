import { randomUUID } from "node:crypto"
import { readFile, rename, stat, writeFile } from "node:fs/promises"
import type { DatasetRow, DatasetSchema } from "@sixb/core"
import { type DatasetVersion, LakeStorageError } from "@sixb/core/lake-storage"
import type { StoredDatasetVersionManifest, StoredManifestInput } from "./types"

export function encodeSegment(value: string): string {
  // Dataset ids often contain dots and other logical separators, so encode before using them on disk.
  return encodeURIComponent(value)
}

export function assertDatasetId(datasetId: string): void {
  if (datasetId.trim().length === 0) {
    throw new LakeStorageError("[LakeLocal] Dataset id must not be empty")
  }
}

export function assertRow(row: DatasetRow): void {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new LakeStorageError("[LakeLocal] Dataset rows must be plain objects")
  }
}

export function selectColumns(row: DatasetRow, columns?: readonly string[]): DatasetRow {
  if (!columns || columns.length === 0) {
    return row
  }

  const selected: Record<string, unknown> = {}
  for (const column of columns) {
    selected[column] = row[column]
  }
  return selected
}

// Canonical content key for unchanged-write detection. JSON.stringify
// serializes Date values via toJSON, matching the persisted JSONL rows;
// missing and undefined nullable values normalize to null. The unchanged-write
// semantics are pinned by the shared lake-storage contract suite.
export function rowContentKey(row: DatasetRow, schema: DatasetSchema): string {
  return JSON.stringify(schema.columns.map((column) => row[column.name] ?? null))
}

// Order-insensitive multiset equality over canonical row keys.
export function sameRowContent(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false
  }

  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((key, index) => key === sortedRight[index])
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  if (!(await pathExists(path))) {
    return null
  }

  const text = await readFile(path, "utf8")
  return JSON.parse(text) as T
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.tmp-${randomUUID()}`
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8")
  await rename(tempPath, path)
}

export function toDatasetVersion(manifest: StoredDatasetVersionManifest): DatasetVersion {
  return {
    datasetId: manifest.datasetId,
    versionId: manifest.versionId,
    parentVersionId: manifest.parentVersionId,
    mode: manifest.mode,
    createdAt: new Date(manifest.createdAt),
    schema: manifest.schema,
    producer: manifest.producer,
    inputs: manifest.inputs,
    rowCount: manifest.rowCount,
    sizeBytes: manifest.sizeBytes,
  }
}

export function toStoredManifest(options: StoredManifestInput): StoredDatasetVersionManifest {
  return {
    datasetId: options.version.datasetId,
    versionId: options.version.versionId,
    parentVersionId: options.version.parentVersionId,
    mode: options.version.mode,
    createdAt: options.version.createdAt.toISOString(),
    schema: options.version.schema,
    producer: options.version.producer,
    inputs: options.version.inputs,
    rowCount: options.version.rowCount,
    sizeBytes: options.version.sizeBytes,
    rowFile: options.rowFile,
    commitMessage: options.commitMessage,
  }
}
