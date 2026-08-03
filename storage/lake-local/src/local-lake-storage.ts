import { randomUUID } from "node:crypto"
import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import {
  type DatasetDefinition,
  type DatasetRow,
  getDatasetRowValidationError,
  type LakeStorage,
} from "@sixb/core"
import { SixbError } from "@sixb/core/errors"
import {
  type BeginDatasetWriteInput,
  type CommitDatasetWriteInput,
  type DatasetCatalogState,
  type DatasetVersion,
  type DatasetWriteCommitResult,
  type DatasetWriteMode,
  type LakeWriteSession,
  mergeStrictDatasetDefinition,
  type ReadDatasetRowsInput,
} from "@sixb/core/lake-storage"
import type {
  CommitWriteInput,
  DatasetState,
  LocalLakeStorageOptions,
  StoredDatasetVersionManifest,
} from "./types"
import {
  assertDatasetId,
  encodeSegment,
  pathExists,
  readJsonFile,
  rowContentKey,
  sameRowContent,
  selectColumns,
  toDatasetVersion,
  toStoredManifest,
  writeJsonAtomic,
} from "./utils"

class LocalLakeWriteSession implements LakeWriteSession {
  private closed = false
  private readonly rowKeys: string[] = []

  constructor(
    private readonly storage: LocalLakeStorage,
    private readonly input: BeginDatasetWriteInput,
    private readonly sessionDir: string,
    private readonly tempRowsPath: string
  ) {}

  async writeRows(rows: Iterable<DatasetRow> | AsyncIterable<DatasetRow>): Promise<void> {
    this.assertOpen()

    const lines: string[] = []
    for await (const row of rows) {
      const validationError = getDatasetRowValidationError(row, this.input.dataset)
      if (validationError) {
        throw new SixbError("storage.lake_failed", `[LakeLocal] ${validationError}`)
      }
      lines.push(`${JSON.stringify(row)}\n`)
      this.rowKeys.push(rowContentKey(row, this.input.dataset.schema))
    }

    if (lines.length > 0) {
      await appendFile(this.tempRowsPath, lines.join(""), "utf8")
    }
  }

  async commit(input?: CommitDatasetWriteInput): Promise<DatasetWriteCommitResult> {
    this.assertOpen()
    this.closed = true

    try {
      return await this.storage.commitWrite({
        write: this.input,
        commit: input,
        rowKeys: this.rowKeys,
        sessionDir: this.sessionDir,
        tempRowsPath: this.tempRowsPath,
      })
    } catch (error) {
      await this.cleanup()
      throw error
    }
  }

  async abort(): Promise<void> {
    this.closed = true
    await this.cleanup()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SixbError("storage.lake_failed", "[LakeLocal] Write session is already closed")
    }
  }

  private async cleanup(): Promise<void> {
    await rm(this.sessionDir, { recursive: true, force: true })
  }
}

/**
 * Local filesystem LakeStorage provider.
 *
 * Layout stays intentionally simple in V1:
 * - dataset definition/state JSON per dataset
 * - immutable version manifests
 * - one JSONL row file per committed version
 */
export class LocalLakeStorage implements LakeStorage {
  private readonly rootPath: string

  constructor(options: LocalLakeStorageOptions) {
    this.rootPath = resolve(options.path ?? ".sixb/lake")
  }

  async createDataset(definition: DatasetDefinition): Promise<DatasetDefinition> {
    assertDatasetId(definition.id)

    await this.ensureDatasetDirs(definition.id)
    const existing = await this.getDataset(definition.id)
    const merged = mergeStrictDatasetDefinition({
      existing,
      next: definition,
    })

    await writeJsonAtomic(this.definitionPath(definition.id), merged)
    return structuredClone(merged)
  }

  async assertDatasetDefinitionsCompatible(
    definitions: readonly DatasetDefinition[]
  ): Promise<void> {
    const failures: string[] = []

    for (const definition of definitions) {
      try {
        assertDatasetId(definition.id)
        const existing = await this.getDataset(definition.id)
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
      throw new SixbError(
        "storage.lake_failed",
        `[SixbLake] Lake dataset definition check failed for ${failures.length} dataset(s).\n${details}`
      )
    }
  }

  async getDataset(datasetId: string): Promise<DatasetDefinition | null> {
    return readJsonFile<DatasetDefinition>(this.definitionPath(datasetId))
  }

  async listDatasets(): Promise<readonly DatasetDefinition[]> {
    await this.ensureBaseDirs()

    const entries = await readdir(this.datasetsRootPath(), { withFileTypes: true })
    const datasets: DatasetDefinition[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      const definition = await readJsonFile<DatasetDefinition>(
        join(this.datasetsRootPath(), entry.name, "definition.json")
      )
      if (definition) {
        datasets.push(definition)
      }
    }

    return datasets.sort((left, right) => left.id.localeCompare(right.id))
  }

  async listDatasetCatalogState(
    datasetIds: readonly string[]
  ): Promise<readonly DatasetCatalogState[]> {
    return Promise.all(
      datasetIds.map(async (datasetId) => {
        if (!(await this.getDataset(datasetId))) {
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
    if (!(await pathExists(this.datasetDir(datasetId)))) {
      return []
    }

    const manifests = await this.readVersionManifests(datasetId)
    const versions = manifests
      .map((manifest) => toDatasetVersion(manifest))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())

    return limit === undefined ? versions : versions.slice(0, Math.max(0, limit))
  }

  async beginWrite(input: BeginDatasetWriteInput): Promise<LakeWriteSession> {
    const definition = await this.getDataset(input.dataset.id)
    if (!definition) {
      throw new SixbError(
        "storage.lake_failed",
        `[LakeLocal] Unknown dataset '${input.dataset.id}'`
      )
    }

    await this.ensureBaseDirs()

    const sessionDir = join(this.tempRootPath(), `session-${randomUUID()}`)
    const tempRowsPath = join(sessionDir, "rows.jsonl")
    await mkdir(sessionDir, { recursive: true })
    await writeFile(tempRowsPath, "", "utf8")

    return new LocalLakeWriteSession(
      this,
      {
        ...input,
        dataset: definition,
        mode: input.mode ?? "snapshot",
      },
      sessionDir,
      tempRowsPath
    )
  }

  async getLatestVersion(datasetId: string): Promise<DatasetVersion | null> {
    const state = await readJsonFile<DatasetState>(this.statePath(datasetId))
    if (!state?.latestVersionId) {
      return null
    }

    return this.getVersion(datasetId, state.latestVersionId)
  }

  async getVersion(datasetId: string, versionId: string): Promise<DatasetVersion | null> {
    const manifest = await readJsonFile<StoredDatasetVersionManifest>(
      this.versionManifestPath(datasetId, versionId)
    )
    return manifest ? toDatasetVersion(manifest) : null
  }

  async *readRows(input: ReadDatasetRowsInput): AsyncIterable<DatasetRow> {
    const definition = await this.getDataset(input.datasetId)
    if (!definition) {
      throw new SixbError("storage.lake_failed", `[LakeLocal] Unknown dataset '${input.datasetId}'`)
    }

    const version =
      input.versionId === undefined
        ? await this.getLatestVersion(input.datasetId)
        : await this.getVersion(input.datasetId, input.versionId)

    if (!version) {
      throw new SixbError(
        "storage.lake_failed",
        `[LakeLocal] No committed version found for dataset '${input.datasetId}'`
      )
    }

    const rowsPath = this.rowsPath(input.datasetId, version.versionId)
    const content = await readFile(rowsPath, "utf8")
    const lines = content.length === 0 ? [] : content.split("\n")

    const offset = Math.max(0, input.offset ?? 0)
    const limit = input.limit === undefined ? undefined : Math.max(0, input.limit)
    let seen = 0
    let yielded = 0
    for (const line of lines) {
      if (!line) {
        continue
      }

      if (seen < offset) {
        seen += 1
        continue
      }

      if (limit !== undefined && yielded >= limit) {
        break
      }

      const row = JSON.parse(line) as DatasetRow
      yield selectColumns(row, input.columns)
      seen += 1
      yielded += 1
    }
  }

  async commitWrite(options: CommitWriteInput): Promise<DatasetWriteCommitResult> {
    const definition = await this.getDataset(options.write.dataset.id)
    if (!definition) {
      throw new SixbError(
        "storage.lake_failed",
        `[LakeLocal] Unknown dataset '${options.write.dataset.id}'`
      )
    }

    await this.ensureDatasetDirs(options.write.dataset.id)

    const latestVersion = await this.getLatestVersion(options.write.dataset.id)
    if (options.commit?.expectedLatestVersionId !== undefined) {
      const actual = latestVersion?.versionId
      if (actual !== options.commit.expectedLatestVersionId) {
        throw new SixbError(
          "storage.lake_failed",
          `[LakeLocal] Optimistic commit failed for dataset '${options.write.dataset.id}': expected latest version '${options.commit.expectedLatestVersionId}', found '${actual ?? "none"}'`
        )
      }
    }

    const mode = options.write.mode ?? "snapshot"

    // Content-identical snapshots and empty appends reuse the latest version
    // instead of creating a new one.
    if (latestVersion && (await this.isUnchangedWrite(mode, options, latestVersion, definition))) {
      await rm(options.sessionDir, { recursive: true, force: true })
      return { ...latestVersion, outcome: "unchanged" }
    }

    const versionId = `ver_${randomUUID()}`
    const versionRowsPath = this.rowsPath(options.write.dataset.id, versionId)

    if (mode === "append" && latestVersion?.versionId) {
      await this.materializeAppendRows({
        datasetId: options.write.dataset.id,
        parentVersionId: latestVersion.versionId,
        tempRowsPath: options.tempRowsPath,
        versionRowsPath,
      })
      await rm(options.sessionDir, { recursive: true, force: true })
    } else {
      await rename(options.tempRowsPath, versionRowsPath)
      await rm(options.sessionDir, { recursive: true, force: true })
    }

    const versionRowsStat = await stat(versionRowsPath)
    const version: DatasetVersion = {
      datasetId: options.write.dataset.id,
      versionId,
      parentVersionId: mode === "append" ? latestVersion?.versionId : undefined,
      mode,
      createdAt: new Date(),
      schema: definition.schema,
      producer: options.write.producer ? structuredClone(options.write.producer) : undefined,
      inputs: options.write.inputs ? structuredClone(options.write.inputs) : undefined,
      rowCount:
        mode === "append"
          ? (latestVersion?.rowCount ?? 0) + options.rowKeys.length
          : options.rowKeys.length,
      sizeBytes: versionRowsStat.size,
    }

    await writeJsonAtomic(
      this.versionManifestPath(options.write.dataset.id, versionId),
      toStoredManifest({
        version,
        rowFile: basename(versionRowsPath),
        commitMessage: options.commit?.commitMessage,
      })
    )
    await writeJsonAtomic(this.statePath(options.write.dataset.id), {
      latestVersionId: versionId,
    })

    return { ...version, outcome: "created" }
  }

  private async isUnchangedWrite(
    mode: DatasetWriteMode,
    options: CommitWriteInput,
    latestVersion: DatasetVersion,
    definition: DatasetDefinition
  ): Promise<boolean> {
    if (mode === "append") {
      return options.rowKeys.length === 0
    }

    if (latestVersion.rowCount !== undefined && latestVersion.rowCount !== options.rowKeys.length) {
      return false
    }

    const previousRowsPath = this.rowsPath(latestVersion.datasetId, latestVersion.versionId)
    if (!(await pathExists(previousRowsPath))) {
      return false
    }

    const previousKeys: string[] = []
    const content = await readFile(previousRowsPath, "utf8")
    for (const line of content.split("\n")) {
      if (line) {
        previousKeys.push(rowContentKey(JSON.parse(line) as DatasetRow, definition.schema))
      }
    }

    return sameRowContent(options.rowKeys, previousKeys)
  }

  private async ensureBaseDirs(): Promise<void> {
    await mkdir(this.datasetsRootPath(), { recursive: true })
    await mkdir(this.tempRootPath(), { recursive: true })
  }

  private async ensureDatasetDirs(datasetId: string): Promise<void> {
    await this.ensureBaseDirs()
    await mkdir(this.datasetDir(datasetId), { recursive: true })
    await mkdir(this.versionsDir(datasetId), { recursive: true })
    await mkdir(this.rowsDir(datasetId), { recursive: true })
  }

  private async readVersionManifests(
    datasetId: string
  ): Promise<readonly StoredDatasetVersionManifest[]> {
    const versionsDir = this.versionsDir(datasetId)
    if (!(await pathExists(versionsDir))) {
      return []
    }

    const entries = await readdir(versionsDir, { withFileTypes: true })
    const manifests: StoredDatasetVersionManifest[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue
      }

      const manifest = await readJsonFile<StoredDatasetVersionManifest>(
        join(versionsDir, entry.name)
      )
      if (manifest) {
        manifests.push(manifest)
      }
    }

    return manifests
  }

  private async materializeAppendRows(options: {
    datasetId: string
    parentVersionId: string
    tempRowsPath: string
    versionRowsPath: string
  }): Promise<void> {
    const parentRowsPath = this.rowsPath(options.datasetId, options.parentVersionId)
    if (!(await pathExists(parentRowsPath))) {
      throw new SixbError(
        "storage.lake_failed",
        `[LakeLocal] Missing parent rows for dataset '${options.datasetId}' version '${options.parentVersionId}'`
      )
    }

    // V1 append is add-only at the API boundary, so each committed version gets a full visible row file.
    await copyFile(parentRowsPath, options.versionRowsPath)

    const appendedRows = await readFile(options.tempRowsPath)
    if (appendedRows.byteLength > 0) {
      await appendFile(options.versionRowsPath, appendedRows)
    }
  }

  private datasetsRootPath(): string {
    return join(this.rootPath, "datasets")
  }

  private tempRootPath(): string {
    return join(this.rootPath, ".tmp")
  }

  private datasetDir(datasetId: string): string {
    return join(this.datasetsRootPath(), encodeSegment(datasetId))
  }

  private definitionPath(datasetId: string): string {
    return join(this.datasetDir(datasetId), "definition.json")
  }

  private statePath(datasetId: string): string {
    return join(this.datasetDir(datasetId), "state.json")
  }

  private versionsDir(datasetId: string): string {
    return join(this.datasetDir(datasetId), "versions")
  }

  private rowsDir(datasetId: string): string {
    return join(this.datasetDir(datasetId), "rows")
  }

  private versionManifestPath(datasetId: string, versionId: string): string {
    return join(this.versionsDir(datasetId), `${encodeSegment(versionId)}.json`)
  }

  private rowsPath(datasetId: string, versionId: string): string {
    return join(this.rowsDir(datasetId), `${encodeSegment(versionId)}.jsonl`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
