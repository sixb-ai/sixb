import { randomUUID } from "node:crypto"
import type { DatasetColumnDefinition, DatasetDefinition, DatasetRow } from "@sixb/core"
import {
  type AnalyzeSqlTransformInput,
  type AnalyzeSqlTransformSource,
  type DatasetColumnLineage,
  type DatasetColumnRef,
  type DatasetProducer,
  type DatasetVersion,
  type DatasetVersionLineage,
  type DatasetVersionRef,
  type DatasetWriteCommitResult,
  type DatasetWriteMode,
  type ExecuteSqlTransformInput,
  type LakeSqlExecutor,
  LakeStorageError,
  type PreviewSqlTransformInput,
  resolveStepLineage,
  type SqlTransformAnalysis,
  type SqlTransformColumnRef,
  type SqlTransformLineage,
} from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import {
  type ApplyDatasetRowsResult,
  applyDatasetRowsFromRelation,
  assertDatasetWriteMode,
} from "./dataset-row-commit"
import { findDatasetColumnTypeForDuckDbSql } from "./duckdb-column-types"
import { getString } from "./duckdb-row"
import type { DuckDbQueryRuntime } from "./duckdb-runtime"
import type { DuckLakeConnectionManager } from "./ducklake-connection-manager"
import type { DuckLakeDatasetCatalog } from "./ducklake-dataset-catalog"
import type { DuckLakeSnapshotReader, DuckLakeTableVersionRef } from "./ducklake-snapshot-reader"
import type { DuckLakeWriteCoordinator } from "./ducklake-write-coordinator"
import { datasetColumnTypeToDuckDbSql } from "./schema"
import { quoteIdentifier } from "./sql"
import { analyzeSqlTransformLineage, type SqlLineageAnalysis } from "./sql-lineage/analysis"
import {
  createDuckLakeSqlTransformTemplate,
  type DuckLakeSqlTransformSourceRelation,
  type DuckLakeSqlTransformTemplate,
  pickSourceColumns,
  renderDuckLakeSourceRelations,
} from "./sql-transform-relations"
import { parseVersionId } from "./versions"

const DEFAULT_PREVIEW_LIMIT = 100
const MAX_PREVIEW_LIMIT = 1_000

interface ResolvedDuckLakeSqlTransformSources {
  readonly relations: Readonly<Record<string, DuckLakeSqlTransformSourceRelation>>
  readonly tables: Readonly<Record<string, ResolvedDuckLakeSourceTable>>
  readonly inputs: readonly DatasetVersionRef[]
}

/** A source's stored definition, and the version it resolved to. */
interface ResolvedDuckLakeSourceTable {
  readonly definition: DatasetDefinition
  readonly version: DuckLakeTableVersionRef
}

interface ApplySqlTransformInput {
  readonly runtime: DuckDbQueryRuntime
  readonly target: DatasetDefinition
  readonly mode: DatasetWriteMode
  readonly sql: string
  readonly checkedCasts: readonly SqlTransformCheckedCast[]
  readonly previousRowCount?: number
}

interface SqlTransformResultColumn {
  readonly name: string
  readonly typeSql: string
}

interface SqlTransformCheckedCast {
  readonly columnName: string
  readonly targetTypeSql: string
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

    const template = createDuckLakeSqlTransformTemplate(Object.keys(input.sources), input.sql)

    const rows = await this.connections.withAttachedRuntime(async (runtime) => {
      const sources = await this.resolveSources(runtime, input.sources)
      const sql = template.render(renderDuckLakeSourceRelations(this.options, sources.relations))
      return runtime.query(buildPreviewSql(sql, previewLimit(input.limit)))
    })

    for (const row of rows) {
      yield normalizePreviewRow(row)
    }
  }

  async execute(input: ExecuteSqlTransformInput<"duckdb">): Promise<DatasetWriteCommitResult> {
    this.connections.assertOpen()
    assertDatasetWriteMode(input.mode, "SQL transform")

    const template = createDuckLakeSqlTransformTemplate(Object.keys(input.sources), input.sql)

    return this.writes.withCommitRuntime(async (runtime) => {
      const target = await this.resolveTargetDataset(runtime, input.target)
      const sources = await this.resolveSources(runtime, input.sources)
      const sql = template.render(renderDuckLakeSourceRelations(this.options, sources.relations))

      const sourceVersions = await this.readSourceVersions(runtime, sources).catch(
        (error: unknown) => skipLineage(target, error)
      )

      // The analysis binds in its own DuckDB instance while the lake checks the result schema.
      const [checkedCasts, stepLineage] = await Promise.all([
        this.assertResultSchemaMatchesTarget(runtime, target, sql),
        sourceVersions === undefined
          ? undefined
          : analyzeExecutedLineage(
              template,
              pinnedSources(sources, sourceVersions),
              sources.relations,
              target
            ),
      ])

      return this.writes.commitDatasetVersionOnExclusiveRuntime(runtime, {
        dataset: target,
        mode: input.mode,
        expectedLatestVersionId: input.expectedLatestVersionId,
        commitMessage: input.commitMessage ?? `execute SQL transform for dataset ${target.id}`,
        producer: input.producer,
        inputs: sources.inputs,
        lineage:
          stepLineage === undefined || sourceVersions === undefined
            ? unanalyzedLineage(target, input.producer)
            : resolveStepLineage(stepLineage, [...sourceVersions.values()]),
        applyChanges: (runtime, context) =>
          this.applySqlTransform({
            runtime,
            target,
            mode: input.mode,
            sql,
            checkedCasts,
            previousRowCount: context.previousRowCount,
          }),
      })
    })
  }

  /**
   * Column lineage bound against the definitions passed in, without reading the lake: it works
   * before any source version exists. Their columns are bound in the order given, which can differ
   * from the lake's stored order; `execute` binds each source's stored version schema instead.
   */
  async analyze(input: AnalyzeSqlTransformInput<"duckdb">): Promise<SqlTransformAnalysis> {
    for (const source of Object.values(input.sources)) {
      this.datasets.assertSchema(source.dataset)
    }

    const analysis = await analyzeSqlTransformLineage({
      sources: input.sources,
      template: createDuckLakeSqlTransformTemplate(Object.keys(input.sources), input.sql),
    })
    return analysis.supported ? { supported: true, lineage: analysis.lineage } : analysis
  }

  private async resolveSources(
    runtime: DuckDbQueryRuntime,
    sources: PreviewSqlTransformInput<"duckdb">["sources"]
  ): Promise<ResolvedDuckLakeSqlTransformSources> {
    const relations: Record<string, DuckLakeSqlTransformSourceRelation> = Object.create(null)
    const tables: Record<string, ResolvedDuckLakeSourceTable> = Object.create(null)
    const inputs: DatasetVersionRef[] = []

    for (const [sourceName, source] of Object.entries(sources)) {
      const definition = await this.resolveSourceDataset(runtime, source.dataset)

      // Rejects a pick of columns the stored definition does not have before any SQL renders it.
      pickSourceColumns(sourceName, definition, source.columns)

      const versionRef = await this.resolveSourceVersion(runtime, definition, source.versionId)

      relations[sourceName] = {
        datasetId: definition.id,
        versionId: versionRef.versionId,
        ...(source.columns === undefined ? {} : { columns: source.columns }),
      }
      tables[sourceName] = { definition, version: versionRef }
      inputs.push({
        datasetId: definition.id,
        versionId: versionRef.versionId,
      })
    }

    return {
      relations: Object.freeze(relations),
      tables: Object.freeze(tables),
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

  /** The source versions read, by source name, with their schemas from one catalog read. */
  private async readSourceVersions(
    runtime: DuckDbQueryRuntime,
    sources: ResolvedDuckLakeSqlTransformSources
  ): Promise<ReadonlyMap<string, DatasetVersion>> {
    const names = Object.keys(sources.tables)
    const versions = await this.snapshots.getVersionsForRefs(
      runtime,
      names.map((sourceName) => sources.tables[sourceName].version)
    )

    return new Map(names.map((sourceName, index) => [sourceName, versions[index]]))
  }

  private async resolveSourceVersion(
    runtime: DuckDbQueryRuntime,
    dataset: DatasetDefinition,
    versionId?: string
  ): Promise<DuckLakeTableVersionRef> {
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
  ): Promise<readonly SqlTransformCheckedCast[]> {
    const rows = await runtime.query(
      `DESCRIBE SELECT * FROM (${sql}) AS sixb_sql_transform_result_schema`
    )
    const actualColumns = rows.map((row) => resultColumnFromDescribeRow(row))
    const expectedColumns = target.schema.columns
    const checkedCasts: SqlTransformCheckedCast[] = []

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

      const actualDatasetType = findDatasetColumnTypeForDuckDbSql(actual.typeSql)
      if (actualDatasetType === expected.type) {
        continue
      }

      if (isCheckedInt64Cast(actual.typeSql, expected.type)) {
        checkedCasts.push({
          columnName: expected.name,
          targetTypeSql: datasetColumnTypeToDuckDbSql(expected.type),
        })
        continue
      }

      throwResultSchemaMismatch(
        target.id,
        `column '${expected.name}' should have type '${expected.type}', got '${actualDatasetType ?? actual.typeSql}'`
      )
    }

    return checkedCasts
  }

  private async applySqlTransform(input: ApplySqlTransformInput): Promise<ApplyDatasetRowsResult> {
    const tempTableName = `sixb_sql_transform_${randomUUID().replaceAll("-", "")}`
    const tempTable = quoteIdentifier(tempTableName)

    await input.runtime.run(
      `CREATE TEMP TABLE ${tempTable} AS SELECT * FROM (${input.sql}) AS sixb_sql_transform_result`
    )

    let result: ApplyDatasetRowsResult
    try {
      for (const checkedCast of input.checkedCasts) {
        await input.runtime.run(
          `ALTER TABLE ${tempTable} ALTER COLUMN ${quoteIdentifier(
            checkedCast.columnName
          )} SET DATA TYPE ${checkedCast.targetTypeSql}`
        )
      }

      result = await applyDatasetRowsFromRelation({
        options: this.options,
        runtime: input.runtime,
        dataset: input.target,
        mode: input.mode,
        sourceRelationSql: tempTable,
        previousRowCount: input.previousRowCount,
      })
    } catch (error) {
      try {
        await input.runtime.run(`DROP TABLE IF EXISTS ${tempTable}`)
      } catch {
        // Preserve the write failure. DuckDB rejects cleanup statements while
        // the transaction is aborted; the coordinator will roll it back next.
      }
      throw error
    }

    await input.runtime.run(`DROP TABLE IF EXISTS ${tempTable}`)
    return result
  }
}

/**
 * Each source as the transform binds it on the lake: the schema of the version it reads, in the
 * stored column order, then its pick. Today's definition may have gained columns since, and a new
 * column can change what a name in the SQL resolves to, such as a lateral alias.
 */
function pinnedSources(
  sources: ResolvedDuckLakeSqlTransformSources,
  versions: ReadonlyMap<string, DatasetVersion>
): Readonly<Record<string, AnalyzeSqlTransformSource>> {
  const pinned: Record<string, AnalyzeSqlTransformSource> = Object.create(null)
  for (const [sourceName, version] of versions) {
    pinned[sourceName] = {
      dataset: { ...sources.tables[sourceName].definition, schema: version.schema },
      columns: sources.relations[sourceName].columns,
    }
  }

  return pinned
}

/**
 * Lineage of the SQL about to run, by the sources' dataset ids, against the schemas of the
 * versions it reads; undefined when it cannot be analyzed exactly. A result shaped unlike the
 * target means the analysis tables diverged from what runs on the lake, so that lineage is not
 * recorded either.
 */
async function analyzeExecutedLineage(
  template: DuckLakeSqlTransformTemplate,
  pinnedSources: Readonly<Record<string, AnalyzeSqlTransformSource>>,
  relations: Readonly<Record<string, DuckLakeSqlTransformSourceRelation>>,
  target: DatasetDefinition
): Promise<DatasetColumnLineage | undefined> {
  let analysis: SqlLineageAnalysis
  try {
    analysis = await analyzeSqlTransformLineage({ sources: pinnedSources, template })
  } catch (error) {
    return skipLineage(target, error)
  }

  if (!analysis.supported || !describesTarget(analysis.outputColumns, target)) {
    return undefined
  }

  return toDatasetColumnLineage(analysis.lineage, relations)
}

/**
 * A pipeline write without lineage is classified with every marking. Any other write without it
 * would depend on its own columns only, so one whose SQL cannot be analyzed records that.
 */
function unanalyzedLineage(
  target: DatasetDefinition,
  producer: DatasetProducer | undefined
): DatasetVersionLineage | undefined {
  return producer?.kind === "pipeline"
    ? undefined
    : { unknown: `a SQL transform into '${target.id}' could not be analyzed` }
}

/**
 * Lineage never fails a transform: invalid SQL or picks fail where the transform binds on the lake.
 * When the analysis cannot even start, the version records no lineage of its own SQL.
 */
function skipLineage(target: DatasetDefinition, error: unknown): undefined {
  const message = error instanceof Error ? error.message : String(error)
  console.warn(
    `[SixbDuckLake] SQL transform into dataset '${target.id}' records no column lineage: ${message}`
  )
  return undefined
}

function describesTarget(outputColumns: readonly string[], target: DatasetDefinition): boolean {
  return (
    outputColumns.length === target.schema.columns.length &&
    target.schema.columns.every((column, index) => outputColumns[index] === column.name)
  )
}

/** Source names become dataset ids; two sources reading one dataset share its column refs. */
function toDatasetColumnLineage(
  lineage: SqlTransformLineage,
  relations: Readonly<Record<string, DuckLakeSqlTransformSourceRelation>>
): DatasetColumnLineage {
  const toRefs = (refs: readonly SqlTransformColumnRef[]): DatasetColumnRef[] => {
    const unique = new Map<string, DatasetColumnRef>()
    for (const { source, column } of refs) {
      const datasetId = relations[source].datasetId
      unique.set(JSON.stringify([datasetId, column]), { datasetId, column })
    }

    return [...unique.values()]
  }

  return {
    rows: toRefs(lineage.rows),
    columns: Object.fromEntries(
      Object.entries(lineage.columns).map(([column, refs]) => [column, toRefs(refs)])
    ),
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
): SqlTransformResultColumn {
  const name = getString(row, "column_name")
  const typeSql = getString(row, "column_type")

  return { name, typeSql }
}

function isCheckedInt64Cast(
  actualTypeSql: string,
  expectedType: DatasetColumnDefinition["type"]
): boolean {
  const normalizedType = actualTypeSql.trim().toUpperCase()
  return expectedType === "int64" && (normalizedType === "HUGEINT" || normalizedType === "INT128")
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
