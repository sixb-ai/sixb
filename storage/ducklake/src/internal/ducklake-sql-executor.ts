import { randomUUID } from "node:crypto"
import type { DatasetColumnDefinition, DatasetDefinition, DatasetRow } from "@sixb/core"
import {
  type DatasetVersionRef,
  type DatasetWriteCommitResult,
  type DatasetWriteMode,
  type ExecuteSqlTransformInput,
  type LakeSqlExecutor,
  LakeStorageError,
  type PreviewSqlTransformInput,
} from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import {
  type ApplyDatasetRowsResult,
  applyDatasetRowsFromRelation,
  assertDatasetWriteMode,
} from "./dataset-row-commit"
import { getString } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import type { DuckLakeDatasetCatalog } from "./ducklake-dataset-catalog"
import type { DuckLakeSnapshotReader } from "./ducklake-snapshot-reader"
import type { DuckLakeWriteCoordinator } from "./ducklake-write-coordinator"
import { duckDbTypeToDatasetColumnType } from "./schema"
import { quoteIdentifier } from "./sql"
import {
  type DuckLakeSqlTransformSourceRelation,
  renderDuckLakeSqlTransformSql,
} from "./sql-transform-relations"
import { parseVersionId } from "./versions"

const DEFAULT_PREVIEW_LIMIT = 100
const MAX_PREVIEW_LIMIT = 1_000

interface ResolvedDuckLakeSqlTransformSources {
  readonly relations: Readonly<Record<string, DuckLakeSqlTransformSourceRelation>>
  readonly inputs: readonly DatasetVersionRef[]
}

interface ApplySqlTransformInput {
  readonly runtime: DuckDbQueryRuntime
  readonly target: DatasetDefinition
  readonly mode: DatasetWriteMode
  readonly sql: string
  readonly previousRowCount?: number
}

/**
 * DuckDB-backed SQL transform executor for DuckLakeStorage.
 */
export class DuckLakeSqlExecutor implements LakeSqlExecutor<"duckdb"> {
  readonly dialect = "duckdb" as const
  readonly capabilities = {
    preview: true,
    supportsAppend: true,
    supportsSnapshot: true,
  }

  constructor(
    private readonly options: DuckLakeStorageOptions,
    private readonly connections: DuckLakeConnectionManager,
    private readonly datasets: DuckLakeDatasetCatalog,
    private readonly snapshots: DuckLakeSnapshotReader,
    private readonly writes: DuckLakeWriteCoordinator
  ) {}

  async *preview(input: PreviewSqlTransformInput<"duckdb">): AsyncIterable<DatasetRow> {
    this.connections.assertOpen()

    const rows = await this.connections.withAttachedRuntime(async (runtime) => {
      const sources = await this.resolveSources(runtime, input.sources)
      const sql = renderDuckLakeSqlTransformSql({
        options: this.options,
        sources: sources.relations,
        sql: input.sql,
      })
      return runtime.query(buildPreviewSql(sql, previewLimit(input.limit)))
    })

    for (const row of rows) {
      yield normalizePreviewRow(row)
    }
  }

  async execute(input: ExecuteSqlTransformInput<"duckdb">): Promise<DatasetWriteCommitResult> {
    this.connections.assertOpen()
    assertDatasetWriteMode(input.mode, "SQL transform")

    return this.writes.withCommitRuntime(async (runtime) => {
      const target = await this.resolveTargetDataset(runtime, input.target)
      const sources = await this.resolveSources(runtime, input.sources)
      const sql = renderDuckLakeSqlTransformSql({
        options: this.options,
        sources: sources.relations,
        sql: input.sql,
      })

      await this.assertResultSchemaMatchesTarget(runtime, target, sql)

      return this.writes.commitDatasetVersionOnExclusiveRuntime(runtime, {
        dataset: target,
        mode: input.mode,
        expectedLatestVersionId: input.expectedLatestVersionId,
        commitMessage: input.commitMessage ?? `execute SQL transform for dataset ${target.id}`,
        producer: input.producer,
        inputs: sources.inputs,
        applyChanges: (runtime, context) =>
          this.applySqlTransform({
            runtime,
            target,
            mode: input.mode,
            sql,
            previousRowCount: context.previousRowCount,
          }),
      })
    })
  }

  private async resolveSources(
    runtime: DuckDbQueryRuntime,
    sources: PreviewSqlTransformInput<"duckdb">["sources"]
  ): Promise<ResolvedDuckLakeSqlTransformSources> {
    const relations: Record<string, DuckLakeSqlTransformSourceRelation> = Object.create(null)
    const inputs: DatasetVersionRef[] = []

    for (const [sourceName, source] of Object.entries(sources)) {
      const definition = await this.resolveSourceDataset(runtime, source.dataset)
      const versionRef = await this.resolveSourceVersion(runtime, definition, source.versionId)

      relations[sourceName] = {
        datasetId: definition.id,
        versionId: versionRef.versionId,
      }
      inputs.push({
        datasetId: definition.id,
        versionId: versionRef.versionId,
      })
    }

    return {
      relations: Object.freeze(relations),
      inputs: Object.freeze(inputs),
    }
  }

  private async resolveSourceDataset(
    runtime: DuckDbQueryRuntime,
    dataset: DatasetDefinition
  ): Promise<DatasetDefinition> {
    const definition = await this.datasets.getDatasetOnRuntime(runtime, dataset.id)
    if (!definition) {
      throw new LakeStorageError(
        `[SixbDuckLake] Unknown SQL transform source dataset '${dataset.id}'.`
      )
    }

    return definition
  }

  private async resolveTargetDataset(
    runtime: DuckDbQueryRuntime,
    dataset: DatasetDefinition
  ): Promise<DatasetDefinition> {
    const definition = await this.datasets.getDatasetOnRuntime(runtime, dataset.id)
    if (!definition) {
      throw new LakeStorageError(
        `[SixbDuckLake] Unknown SQL transform target dataset '${dataset.id}'.`
      )
    }

    this.datasets.assertSchema(definition)
    return definition
  }

  private async resolveSourceVersion(
    runtime: DuckDbQueryRuntime,
    dataset: DatasetDefinition,
    versionId?: string
  ): Promise<DatasetVersionRef> {
    if (versionId !== undefined) {
      const snapshotId = parseVersionId(versionId)
      const versionRef = await this.snapshots.getVersionRefForSnapshot(runtime, dataset, snapshotId)
      if (versionRef) {
        return versionRef
      }

      throwNoCommittedSourceVersion(dataset.id)
    }

    const latestVersionRef = await this.snapshots.getLatestVersionRefForDefinition(runtime, dataset)
    if (latestVersionRef) {
      return latestVersionRef
    }

    throwNoCommittedSourceVersion(dataset.id)
  }

  private async assertResultSchemaMatchesTarget(
    runtime: DuckDbQueryRuntime,
    target: DatasetDefinition,
    sql: string
  ): Promise<void> {
    const rows = await runtime.query(
      `DESCRIBE SELECT * FROM (${sql}) AS sixb_sql_transform_result_schema`
    )
    const actualColumns = rows.map((row) => resultColumnFromDescribeRow(row))
    const expectedColumns = target.schema.columns

    if (actualColumns.length !== expectedColumns.length) {
      throwResultSchemaMismatch(
        target.id,
        `expected ${expectedColumns.length} columns, got ${actualColumns.length}`
      )
    }

    for (let index = 0; index < expectedColumns.length; index += 1) {
      const expected = expectedColumns[index]
      const actual = actualColumns[index]

      if (actual.name !== expected.name) {
        throwResultSchemaMismatch(
          target.id,
          `column ${index + 1} should be '${expected.name}', got '${actual.name}'`
        )
      }

      if (actual.type !== expected.type) {
        throwResultSchemaMismatch(
          target.id,
          `column '${expected.name}' should have type '${expected.type}', got '${actual.type}'`
        )
      }
    }
  }

  private async applySqlTransform(input: ApplySqlTransformInput): Promise<ApplyDatasetRowsResult> {
    const tempTableName = `sixb_sql_transform_${randomUUID().replaceAll("-", "")}`
    const tempTable = quoteIdentifier(tempTableName)

    await input.runtime.run(
      `CREATE TEMP TABLE ${tempTable} AS SELECT * FROM (${input.sql}) AS sixb_sql_transform_result`
    )

    try {
      return await applyDatasetRowsFromRelation({
        options: this.options,
        runtime: input.runtime,
        dataset: input.target,
        mode: input.mode,
        sourceRelationSql: tempTable,
        previousRowCount: input.previousRowCount,
      })
    } finally {
      await input.runtime.run(`DROP TABLE IF EXISTS ${tempTable}`)
    }
  }
}

function previewLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_PREVIEW_LIMIT
  }

  return Math.min(Math.max(0, Math.trunc(limit)), MAX_PREVIEW_LIMIT)
}

function buildPreviewSql(sql: string, limit: number): string {
  return `SELECT * FROM (${sql}) AS sixb_sql_transform_preview LIMIT ${limit}`
}

function resultColumnFromDescribeRow(
  row: Readonly<Record<string, unknown>>
): DatasetColumnDefinition {
  const name = getString(row, "column_name")
  const type = duckDbTypeToDatasetColumnType(getString(row, "column_type"))

  return { name, type }
}

function normalizePreviewRow(row: Readonly<Record<string, unknown>>): DatasetRow {
  const normalized: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(row)) {
    normalized[key] = normalizePreviewValue(value)
  }

  return normalized
}

function normalizePreviewValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString()
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizePreviewValue(item))
  }

  if (typeof value === "object" && value !== null) {
    const normalized: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      normalized[key] = normalizePreviewValue(child)
    }
    return normalized
  }

  return value
}

function throwNoCommittedSourceVersion(datasetId: string): never {
  throw new LakeStorageError(
    `[SixbDuckLake] No committed version found for SQL transform source dataset '${datasetId}'.`
  )
}

function throwResultSchemaMismatch(datasetId: string, detail: string): never {
  throw new LakeStorageError(
    `[SixbDuckLake] SQL transform result schema does not match target dataset '${datasetId}': ${detail}.`
  )
}
