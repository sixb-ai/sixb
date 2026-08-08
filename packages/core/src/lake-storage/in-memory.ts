import { randomUUID } from "node:crypto"
import type { DatasetDefinition, DatasetSchema, MergeChange } from "../datasets"
import { getDatasetRowValidationError } from "../datasets/validation"
import { mergeStrictDatasetDefinition } from "./definition-updates"
import { LakeStorageError } from "./errors"
import type {
  BeginDatasetMergeInput,
  CommitDatasetMergeInput,
  DatasetMergeCommitResult,
  LakeMergeSession,
} from "./merge"
import {
  cloneDatasetMergeChange,
  encodeDatasetPrimaryKey,
  getDatasetMergeChangeValidationError,
  getDatasetPrimaryKeyColumns,
} from "./merge-validation"
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
  private readonly primaryKeys = new Set<string>()
  private closed = false

  constructor(
    private readonly storage: InMemoryLakeStorage,
    private readonly input: BeginDatasetWriteInput
  ) {}

  async writeRows(rows: Iterable<DatasetRow> | AsyncIterable<DatasetRow>): Promise<void> {
    this.assertOpen()

    const stagedRows: DatasetRow[] = []
    const stagedPrimaryKeys = new Set<string>()
    for await (const row of rows) {
      const validationError = getDatasetRowValidationError(row, this.input.dataset)
      if (validationError) {
        throw new LakeStorageError(`[LakeStorage] ${validationError}`)
      }

      if (getDatasetPrimaryKeyColumns(this.input.dataset) !== null) {
        const primaryKey = encodeDatasetPrimaryKey(this.input.dataset, row)
        if (this.primaryKeys.has(primaryKey) || stagedPrimaryKeys.has(primaryKey)) {
          throw new LakeStorageError(
            `[LakeStorage] Dataset '${this.input.dataset.id}' write contains duplicate primary key ${primaryKey}.`
          )
        }
        stagedPrimaryKeys.add(primaryKey)
      }

      stagedRows.push(cloneRow(row))
    }

    this.rows.push(...stagedRows)
    for (const primaryKey of stagedPrimaryKeys) {
      this.primaryKeys.add(primaryKey)
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

class InMemoryLakeMergeSession implements LakeMergeSession {
  private readonly changes: MergeChange<DatasetRow, DatasetRow>[] = []
  private closed = false

  constructor(
    private readonly storage: InMemoryLakeStorage,
    private readonly input: BeginDatasetMergeInput,
    private readonly baseVersionId: string | null
  ) {}

  async writeChanges(
    changes:
      | Iterable<MergeChange<DatasetRow, DatasetRow>>
      | AsyncIterable<MergeChange<DatasetRow, DatasetRow>>
  ): Promise<void> {
    this.assertOpen()

    const stagedChanges: MergeChange<DatasetRow, DatasetRow>[] = []
    for await (const change of changes) {
      const validationError = getDatasetMergeChangeValidationError(change, this.input.dataset)
      if (validationError) {
        throw new LakeStorageError(`[LakeStorage] ${validationError}`)
      }
      stagedChanges.push(cloneDatasetMergeChange(change))
    }
    this.changes.push(...stagedChanges)
  }

  async commit(input?: CommitDatasetMergeInput): Promise<DatasetMergeCommitResult> {
    this.assertOpen()
    this.closed = true
    return this.storage.commitMerge({
      merge: this.input,
      baseVersionId: this.baseVersionId,
      changes: this.changes,
      commit: input,
    })
  }

  async abort(): Promise<void> {
    this.closed = true
    this.changes.length = 0
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new LakeStorageError("[LakeStorage] Merge session is already closed")
    }
  }
}

export class InMemoryLakeStorage implements LakeStorage {
  private readonly datasets = new Map<string, DatasetDefinition>()
  private readonly versionsByDataset = new Map<string, DatasetVersion[]>()
  private readonly rowsByVersionId = new Map<string, readonly DatasetRow[]>()
  private readonly latestVersionIdByDataset = new Map<string, string>()
  private readonly commitLocks = new Map<string, Promise<void>>()

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

  async beginMerge(input: BeginDatasetMergeInput): Promise<LakeMergeSession> {
    const definition = await this.getDataset(input.dataset.id)
    if (!definition) {
      throw new LakeStorageError(`[LakeStorage] Unknown dataset '${input.dataset.id}'`)
    }
    if (getDatasetPrimaryKeyColumns(definition) === null) {
      throw new LakeStorageError(
        `[LakeStorage] Dataset '${definition.id}' must define a primaryKey before it can be merged.`
      )
    }

    const latestVersion = await this.getLatestVersion(definition.id)
    if (
      input.expectedLatestVersionId !== undefined &&
      latestVersion?.versionId !== input.expectedLatestVersionId
    ) {
      throw new LakeStorageError(
        `[LakeStorage] Optimistic merge start failed for dataset '${definition.id}': expected latest version '${input.expectedLatestVersionId}', found '${latestVersion?.versionId ?? "none"}'`
      )
    }
    return new InMemoryLakeMergeSession(
      this,
      {
        ...input,
        dataset: definition,
      },
      latestVersion?.versionId ?? null
    )
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
    return this.withDatasetCommitLock(options.write.dataset.id, () =>
      this.commitWriteUnlocked(options)
    )
  }

  async commitMerge(options: {
    merge: BeginDatasetMergeInput
    baseVersionId: string | null
    changes: readonly MergeChange<DatasetRow, DatasetRow>[]
    commit?: CommitDatasetMergeInput
  }): Promise<DatasetMergeCommitResult> {
    return this.withDatasetCommitLock(options.merge.dataset.id, async () => {
      const definition = this.datasets.get(options.merge.dataset.id)
      if (!definition) {
        throw new LakeStorageError(`[LakeStorage] Unknown dataset '${options.merge.dataset.id}'`)
      }

      const latestVersion = await this.getLatestVersion(options.merge.dataset.id)
      const actualVersionId = latestVersion?.versionId ?? null
      if (actualVersionId !== options.baseVersionId) {
        throw new LakeStorageError(
          `[LakeStorage] Optimistic merge commit failed for dataset '${options.merge.dataset.id}': expected latest version '${options.baseVersionId ?? "none"}', found '${actualVersionId ?? "none"}'`
        )
      }

      const previousRows = this.rowsByVersionId.get(latestVersion?.versionId ?? "") ?? []
      const previousByKey = this.rowsByPrimaryKey(previousRows, definition)
      const finalChanges = new Map<string, MergeChange<DatasetRow, DatasetRow>>()
      for (const change of options.changes) {
        const value = change.kind === "upsert" ? change.row : change.key
        finalChanges.set(encodeDatasetPrimaryKey(definition, value), change)
      }

      const nextByKey = new Map(previousByKey)
      for (const [primaryKey, change] of finalChanges) {
        if (change.kind === "upsert") {
          nextByKey.set(primaryKey, cloneRow(change.row))
        } else {
          nextByKey.delete(primaryKey)
        }
      }

      if (this.sameKeyedRowContent(previousByKey, nextByKey, definition.schema)) {
        return {
          outcome: "unchanged",
          version: latestVersion ? cloneDatasetVersion(latestVersion) : null,
        }
      }

      const visibleRows = [...nextByKey.values()]
      const versionId = `ver_${randomUUID()}`
      const version: DatasetVersion = {
        datasetId: options.merge.dataset.id,
        versionId,
        parentVersionId: latestVersion?.versionId,
        mode: "merge",
        createdAt: new Date(),
        schema: definition.schema,
        producer: options.merge.producer ? structuredClone(options.merge.producer) : undefined,
        inputs: options.merge.inputs ? structuredClone(options.merge.inputs) : undefined,
        rowCount: visibleRows.length,
        sizeBytes: new TextEncoder().encode(
          visibleRows.map((row) => JSON.stringify(row)).join("\n")
        ).byteLength,
      }

      const versions = this.versionsByDataset.get(options.merge.dataset.id) ?? []
      versions.push(version)
      this.versionsByDataset.set(options.merge.dataset.id, versions)
      this.rowsByVersionId.set(
        versionId,
        visibleRows.map((row) => cloneRow(row))
      )
      this.latestVersionIdByDataset.set(options.merge.dataset.id, versionId)

      return { outcome: "created", version: cloneDatasetVersion(version) }
    })
  }

  private async commitWriteUnlocked(options: {
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

    this.assertKeyedWriteIsUnique(mode, options.rows, latestVersion, definition)

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

  private assertKeyedWriteIsUnique(
    mode: DatasetWriteMode,
    rows: readonly DatasetRow[],
    latestVersion: DatasetVersion | null,
    definition: DatasetDefinition
  ): void {
    if (getDatasetPrimaryKeyColumns(definition) === null) {
      return
    }

    const stagedByKey = this.rowsByPrimaryKey(rows, definition)
    if (mode !== "append" || latestVersion === null) {
      return
    }

    const previousRows = this.rowsByVersionId.get(latestVersion.versionId) ?? []
    const previousByKey = this.rowsByPrimaryKey(previousRows, definition)
    for (const primaryKey of stagedByKey.keys()) {
      if (previousByKey.has(primaryKey)) {
        throw new LakeStorageError(
          `[LakeStorage] Dataset '${definition.id}' append contains duplicate primary key ${primaryKey}.`
        )
      }
    }
  }

  private rowsByPrimaryKey(
    rows: readonly DatasetRow[],
    definition: DatasetDefinition
  ): Map<string, DatasetRow> {
    const byKey = new Map<string, DatasetRow>()
    for (const row of rows) {
      const primaryKey = encodeDatasetPrimaryKey(definition, row)
      if (byKey.has(primaryKey)) {
        throw new LakeStorageError(
          `[LakeStorage] Dataset '${definition.id}' contains duplicate primary key ${primaryKey}.`
        )
      }
      byKey.set(primaryKey, row)
    }
    return byKey
  }

  private sameKeyedRowContent(
    left: ReadonlyMap<string, DatasetRow>,
    right: ReadonlyMap<string, DatasetRow>,
    schema: DatasetSchema
  ): boolean {
    if (left.size !== right.size) {
      return false
    }
    for (const [primaryKey, leftRow] of left) {
      const rightRow = right.get(primaryKey)
      if (
        rightRow === undefined ||
        rowContentKey(leftRow, schema) !== rowContentKey(rightRow, schema)
      ) {
        return false
      }
    }
    return true
  }

  private async withDatasetCommitLock<T>(datasetId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.commitLocks.get(datasetId) ?? Promise.resolve()
    const ready = previous.catch(() => {})
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const current = ready.then(() => next)
    this.commitLocks.set(datasetId, current)

    await ready
    try {
      return await run()
    } finally {
      release()
      if (this.commitLocks.get(datasetId) === current) {
        this.commitLocks.delete(datasetId)
      }
    }
  }
}
