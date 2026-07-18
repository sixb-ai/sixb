import { randomUUID } from "node:crypto"
import type { DatasetDefinition, DatasetSchema } from "../datasets"
import { getDatasetRowValidationError } from "../datasets/validation"
import { mergeStrictDatasetDefinition } from "./definition-updates"
import { LakeStorageError } from "./errors"
import type {
  BeginDatasetWriteInput,
  CommitDatasetWriteInput,
  DatasetCatalogState,
  DatasetRow,
  DatasetVersion,
  DatasetWriteCommitResult,
  DatasetWriteMode,
  LakeStorage,
  LakeWriteSession,
  ReadDatasetRowsInput,
} from "./types"

function cloneDatasetDefinition(definition: DatasetDefinition): DatasetDefinition {
  return structuredClone(definition)
}

function cloneDatasetVersion(version: DatasetVersion): DatasetVersion {
  return {
    ...structuredClone(version),
    createdAt: new Date(version.createdAt),
  }
}

function cloneRow(row: DatasetRow): DatasetRow {
  return structuredClone(row)
}

function selectColumns(row: DatasetRow, columns?: readonly string[]): DatasetRow {
  if (!columns || columns.length === 0) {
    return cloneRow(row)
  }

  const selected: Record<string, unknown> = {}
  for (const column of columns) {
    selected[column] = row[column]
  }
  return selected
}

// Canonical content key for unchanged-write detection. JSON.stringify
// serializes Date values via toJSON, matching how rows persist as JSON;
// missing and undefined nullable values normalize to null. The unchanged-write
// semantics are pinned by the shared lake-storage contract suite.
function rowContentKey(row: DatasetRow, schema: DatasetSchema): string {
  return JSON.stringify(schema.columns.map((column) => row[column.name] ?? null))
}

// Order-insensitive multiset equality over canonical row keys.
function sameRowContent(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false
  }

  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((key, index) => key === sortedRight[index])
}

function assertDatasetId(datasetId: string): void {
  if (datasetId.trim().length === 0) {
    throw new LakeStorageError("[LakeStorage] Dataset id must not be empty")
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class InMemoryLakeWriteSession implements LakeWriteSession {
  private readonly rows: DatasetRow[] = []
  private closed = false

  constructor(
    private readonly storage: InMemoryLakeStorage,
    private readonly input: BeginDatasetWriteInput
  ) {}

  async writeRows(rows: Iterable<DatasetRow> | AsyncIterable<DatasetRow>): Promise<void> {
    this.assertOpen()

    for await (const row of rows) {
      const validationError = getDatasetRowValidationError(row, this.input.dataset)
      if (validationError) {
        throw new LakeStorageError(`[LakeStorage] ${validationError}`)
      }

      this.rows.push(cloneRow(row))
    }
  }

  async commit(input?: CommitDatasetWriteInput): Promise<DatasetWriteCommitResult> {
    this.assertOpen()
    this.closed = true
    return this.storage.commitWrite({
      write: this.input,
      rows: this.rows,
      commit: input,
    })
  }

  async abort(): Promise<void> {
    this.closed = true
    this.rows.length = 0
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new LakeStorageError("[LakeStorage] Write session is already closed")
    }
  }
}

export class InMemoryLakeStorage implements LakeStorage {
  private readonly datasets = new Map<string, DatasetDefinition>()
  private readonly versionsByDataset = new Map<string, DatasetVersion[]>()
  private readonly rowsByVersionId = new Map<string, readonly DatasetRow[]>()
  private readonly latestVersionIdByDataset = new Map<string, string>()

  async createDataset(definition: DatasetDefinition): Promise<DatasetDefinition> {
    assertDatasetId(definition.id)
    const existing = this.datasets.get(definition.id)
    const stored = mergeStrictDatasetDefinition({
      existing,
      next: definition,
    })
    this.datasets.set(definition.id, stored)
    return cloneDatasetDefinition(stored)
  }

  async assertDatasetDefinitionsCompatible(
    definitions: readonly DatasetDefinition[]
  ): Promise<void> {
    const failures: string[] = []

    for (const definition of definitions) {
      try {
        assertDatasetId(definition.id)
        const existing = this.datasets.get(definition.id)
        if (!existing) {
          continue
        }

        mergeStrictDatasetDefinition({
          existing,
          next: definition,
        })
      } catch (error) {
        failures.push(`- ${definition.id}: ${errorMessage(error)}`)
      }
    }

    if (failures.length > 0) {
      const details = failures.join("\n")
      throw new LakeStorageError(
        `[SixbLake] Lake dataset definition check failed for ${failures.length} dataset(s).\n${details}`
      )
    }
  }

  async getDataset(datasetId: string): Promise<DatasetDefinition | null> {
    const definition = this.datasets.get(datasetId)
    return definition ? cloneDatasetDefinition(definition) : null
  }

  async listDatasets(): Promise<readonly DatasetDefinition[]> {
    return [...this.datasets.values()].map((definition) => cloneDatasetDefinition(definition))
  }

  async listDatasetCatalogState(
    datasetIds: readonly string[]
  ): Promise<readonly DatasetCatalogState[]> {
    return Promise.all(
      datasetIds.map(async (datasetId) => {
        if (!this.datasets.has(datasetId)) {
          return { datasetId, materialized: false, latestVersion: null }
        }

        const latest = await this.getLatestVersion(datasetId)
        return {
          datasetId,
          materialized: true,
          latestVersion: latest
            ? {
                datasetId: latest.datasetId,
                versionId: latest.versionId,
                mode: latest.mode,
                createdAt: latest.createdAt,
                ...(latest.rowCount !== undefined ? { rowCount: latest.rowCount } : {}),
              }
            : null,
        }
      })
    )
  }

  async listVersions(datasetId: string, limit?: number): Promise<readonly DatasetVersion[]> {
    const versions = [...(this.versionsByDataset.get(datasetId) ?? [])]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map((version) => cloneDatasetVersion(version))

    return limit === undefined ? versions : versions.slice(0, Math.max(0, limit))
  }

  async beginWrite(input: BeginDatasetWriteInput): Promise<LakeWriteSession> {
    const definition = await this.getDataset(input.dataset.id)
    if (!definition) {
      throw new LakeStorageError(`[LakeStorage] Unknown dataset '${input.dataset.id}'`)
    }

    return new InMemoryLakeWriteSession(this, {
      ...input,
      dataset: definition,
      mode: input.mode ?? "snapshot",
    })
  }

  async getLatestVersion(datasetId: string): Promise<DatasetVersion | null> {
    const latestVersionId = this.latestVersionIdByDataset.get(datasetId)
    if (!latestVersionId) {
      return null
    }

    return this.getVersion(datasetId, latestVersionId)
  }

  async getVersion(datasetId: string, versionId: string): Promise<DatasetVersion | null> {
    const versions = this.versionsByDataset.get(datasetId) ?? []
    const version = versions.find((candidate) => candidate.versionId === versionId)
    return version ? cloneDatasetVersion(version) : null
  }

  async *readRows(input: ReadDatasetRowsInput): AsyncIterable<DatasetRow> {
    const definition = this.datasets.get(input.datasetId)
    if (!definition) {
      throw new LakeStorageError(`[LakeStorage] Unknown dataset '${input.datasetId}'`)
    }

    const version =
      input.versionId === undefined
        ? await this.getLatestVersion(input.datasetId)
        : await this.getVersion(input.datasetId, input.versionId)

    if (!version) {
      throw new LakeStorageError(
        `[LakeStorage] No committed version found for dataset '${input.datasetId}'`
      )
    }

    const offset = Math.max(0, input.offset ?? 0)
    const limit = input.limit === undefined ? undefined : Math.max(0, input.limit)
    const rows = this.rowsByVersionId
      .get(version.versionId)
      ?.slice(offset, limit === undefined ? undefined : offset + limit)

    for (const row of rows ?? []) {
      yield selectColumns(row, input.columns)
    }
  }

  async commitWrite(options: {
    write: BeginDatasetWriteInput
    rows: readonly DatasetRow[]
    commit?: CommitDatasetWriteInput
  }): Promise<DatasetWriteCommitResult> {
    const definition = this.datasets.get(options.write.dataset.id)
    if (!definition) {
      throw new LakeStorageError(`[LakeStorage] Unknown dataset '${options.write.dataset.id}'`)
    }

    const mode = options.write.mode ?? "snapshot"
    const latestVersion = await this.getLatestVersion(options.write.dataset.id)

    if (options.commit?.expectedLatestVersionId !== undefined) {
      const actual = latestVersion?.versionId
      if (actual !== options.commit.expectedLatestVersionId) {
        throw new LakeStorageError(
          `[LakeStorage] Optimistic commit failed for dataset '${options.write.dataset.id}': expected latest version '${options.commit.expectedLatestVersionId}', found '${actual ?? "none"}'`
        )
      }
    }

    // Content-identical snapshots and empty appends reuse the latest version
    // instead of creating a new one.
    if (
      latestVersion &&
      this.isUnchangedWrite(mode, latestVersion, options.rows, definition.schema)
    ) {
      return { ...latestVersion, outcome: "unchanged" }
    }

    const versionId = `ver_${randomUUID()}`
    const visibleRows =
      mode === "append"
        ? [...(this.rowsByVersionId.get(latestVersion?.versionId ?? "") ?? []), ...options.rows]
        : [...options.rows]

    const sizeBytes = new TextEncoder().encode(
      visibleRows.map((row) => JSON.stringify(row)).join("\n")
    ).byteLength

    const version: DatasetVersion = {
      datasetId: options.write.dataset.id,
      versionId,
      parentVersionId: mode === "append" ? latestVersion?.versionId : undefined,
      mode,
      createdAt: new Date(),
      schema: definition.schema,
      producer: options.write.producer ? structuredClone(options.write.producer) : undefined,
      inputs: options.write.inputs ? structuredClone(options.write.inputs) : undefined,
      rowCount: visibleRows.length,
      sizeBytes,
    }

    const versions = this.versionsByDataset.get(options.write.dataset.id) ?? []
    versions.push(version)
    this.versionsByDataset.set(options.write.dataset.id, versions)
    this.rowsByVersionId.set(
      versionId,
      visibleRows.map((row) => cloneRow(row))
    )
    this.latestVersionIdByDataset.set(options.write.dataset.id, versionId)

    return { ...cloneDatasetVersion(version), outcome: "created" }
  }

  private isUnchangedWrite(
    mode: DatasetWriteMode,
    latestVersion: DatasetVersion,
    rows: readonly DatasetRow[],
    schema: DatasetSchema
  ): boolean {
    if (mode === "append") {
      return rows.length === 0
    }

    const previousRows = this.rowsByVersionId.get(latestVersion.versionId) ?? []
    return sameRowContent(
      rows.map((row) => rowContentKey(row, schema)),
      previousRows.map((row) => rowContentKey(row, schema))
    )
  }
}
