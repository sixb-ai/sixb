import type { DatasetVersion } from "@sixb/core/lake-storage"
import {
  type LakeFile,
  type LakeForks,
  type LakeSliceVersion,
  LakeStorageError,
  type LakeVersionsAtInput,
  type ReleaseLakeSliceFilesInput,
  type WriteLakeSliceInput,
} from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { catalogDataPath, type SliceTable, writeCatalogSlice } from "./catalog-slice"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import { resolveDatasetTableRef } from "./ducklake-dataset-table-ref"
import type { DuckLakeSnapshotReader } from "./ducklake-snapshot-reader"
import { COPIES_PREFIX, LakeFiles } from "./lake-files"
import { encodeDatasetSequenceTableName } from "./names"
import { parseVersionId, toVersionId } from "./versions"

// A copy younger than this may belong to a cut whose token is not stored yet.
const COPY_GRACE_MS = 60 * 60_000

/**
 * Production's side of a branch: points, catalog slices and the files they read. A point is the
 * id of a catalog snapshot, written as a version id. See the README, "Branches".
 *
 * Everything runs on a connection of its own (`withDedicatedConnection`): cutting a slice, which
 * may copy files, never holds the attachment lock the lake's reads and writes take.
 */
export class DuckLakeForks implements LakeForks {
  private files: Promise<LakeFiles> | undefined

  constructor(
    private readonly options: DuckLakeStorageOptions,
    private readonly connections: DuckLakeConnectionManager,
    private readonly snapshots: DuckLakeSnapshotReader
  ) {}

  async currentPoint(): Promise<string> {
    return this.connections.withDedicatedConnection(async (runtime) =>
      toVersionId(await this.snapshots.queryHeadSnapshotId(runtime))
    )
  }

  async versionsAt(
    input: LakeVersionsAtInput
  ): Promise<ReadonlyMap<string, DatasetVersion | null>> {
    const point = parsePoint(input.point)

    return this.connections.withDedicatedConnection(async (runtime) => {
      const versions = new Map<string, DatasetVersion | null>()
      for (const datasetId of input.datasetIds) {
        const table = await resolveDatasetTableRef(this.options, runtime, datasetId)
        versions.set(
          datasetId,
          table ? await this.snapshots.getVersionAtSnapshot(runtime, table, point) : null
        )
      }
      return versions
    })
  }

  async writeSlice(input: WriteLakeSliceInput): Promise<ReadonlySet<string>> {
    const point = parsePoint(input.point)
    const files = await this.lakeFiles()

    return this.connections.withDedicatedConnection(async (runtime) => {
      const tables = await this.sliceTables(runtime, input.versions, point)
      return writeCatalogSlice(this.options, runtime, files, {
        tables,
        pointSnapshotId: BigInt(point),
        path: input.path,
        record: input.record,
      })
    })
  }

  async openFile(path: string): Promise<LakeFile | null> {
    return (await this.lakeFiles()).open(path)
  }

  async releaseFiles(input: ReleaseLakeSliceFilesInput): Promise<number> {
    const files = await this.lakeFiles()
    const kept = new Set<string>()
    for (const paths of input.liveSlices) {
      for (const path of paths) {
        if (path.startsWith(COPIES_PREFIX)) kept.add(path.slice(COPIES_PREFIX.length))
      }
    }

    let released = 0
    const cutoff = Date.now() - COPY_GRACE_MS
    for (const copy of await files.listCopies()) {
      if (kept.has(copy.name) || copy.writtenAt.getTime() > cutoff) continue

      // A cut may have reused it since it was listed: its time is read again before it goes.
      const writtenAt = await files.copyWrittenAt(copy.name)
      if (!writtenAt || writtenAt.getTime() > cutoff) continue
      await files.deleteCopy(copy.name)
      released += 1
    }
    return released
  }

  private lakeFiles(): Promise<LakeFiles> {
    this.files ??= this.connections
      .withDedicatedConnection((runtime) => catalogDataPath(this.options, runtime))
      .then((dataPath) => new LakeFiles(this.options, dataPath))
      .catch((error) => {
        this.files = undefined
        throw error
      })
    return this.files
  }

  /**
   * The tables the versions hold, each at its version's snapshot: a dataset's own table and the
   * table it keeps source ordering in. Each version must exist and be at or before the point.
   */
  private async sliceTables(
    runtime: DuckDbQueryRuntime,
    versions: readonly LakeSliceVersion[],
    point: string
  ): Promise<SliceTable[]> {
    const datasets = new Set(versions.map((version) => version.datasetId))
    if (datasets.size !== versions.length) {
      throw new LakeStorageError("[SixbDuckLake] A lake slice holds one version per dataset.")
    }

    const tables: SliceTable[] = []
    for (const version of versions) {
      const { datasetId, versionId } = version
      const snapshotId = parseVersionId(versionId)
      const table = await resolveDatasetTableRef(this.options, runtime, datasetId)

      const found = table && (await this.snapshots.getSnapshotRow(runtime, table, snapshotId))
      if (!table || !found) {
        throw new LakeStorageError(
          `[SixbDuckLake] Version '${versionId}' of dataset '${datasetId}' does not exist.`
        )
      }
      if (BigInt(snapshotId) > BigInt(point)) {
        throw new LakeStorageError(
          `[SixbDuckLake] Version '${versionId}' of dataset '${datasetId}' is after the slice's point '${toVersionId(point)}'.`
        )
      }

      const producer = version.producer
      const shared = {
        datasetId,
        snapshotId: BigInt(snapshotId),
        ...(producer === undefined ? {} : { producer }),
      }
      tables.push({ ...shared, tableId: table.tableId, tableName: table.tableName })
      if (table.sequenceTableId !== undefined) {
        tables.push({
          ...shared,
          tableId: table.sequenceTableId,
          tableName: encodeDatasetSequenceTableName(datasetId),
        })
      }
    }

    return tables
  }
}

function parsePoint(point: string): string {
  try {
    return parseVersionId(point)
  } catch {
    throw new LakeStorageError(`[SixbDuckLake] '${point}' is not a point of this lake.`)
  }
}
