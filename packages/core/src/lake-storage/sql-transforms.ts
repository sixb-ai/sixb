import type { DatasetDefinition } from "../datasets"
import type {
  DatasetProducer,
  DatasetRow,
  DatasetWriteCommitResult,
  DatasetWriteMode,
  LakeStorage,
} from "./types"

export const SQL_DIALECT = {
  duckdb: "duckdb",
} as const

export const SQL_DIALECTS = Object.values(SQL_DIALECT)
export type SqlDialect = (typeof SQL_DIALECT)[keyof typeof SQL_DIALECT]

export interface LakeStorageWithSql<TSqlDialect extends SqlDialect = SqlDialect>
  extends LakeStorage {
  readonly sql: LakeSqlExecutor<TSqlDialect>
}

export interface LakeSqlExecutor<TSqlDialect extends SqlDialect = SqlDialect> {
  readonly dialect: TSqlDialect
  readonly capabilities: LakeSqlTransformCapabilities

  preview(input: PreviewSqlTransformInput<TSqlDialect>): AsyncIterable<DatasetRow>
  /**
   * Records the resolved lineage of the executed SQL on the committed version, as the writer of a
   * run step passes `BeginDatasetWriteInput.lineage`: the provider analyzes the SQL it executes
   * (as `analyze`), maps that lineage through the source versions it read with
   * `resolveStepLineage`, and stores what `lineageAtCommit` returns for it, which merges in what an
   * append keeps of its parent. When it cannot analyze the SQL, it passes no lineage, and the
   * version is classified with every marking.
   */
  execute(input: ExecuteSqlTransformInput<TSqlDialect>): Promise<DatasetWriteCommitResult>
  /**
   * Column lineage of a transform, bound against the sources' column schemas without reading any
   * data. A provider without it cannot run SQL over marked columns.
   */
  analyze?(input: AnalyzeSqlTransformInput<TSqlDialect>): Promise<SqlTransformAnalysis>
}

export interface LakeSqlTransformCapabilities {
  readonly preview: boolean
  readonly supportsAppend: boolean
  readonly supportsSnapshot: boolean
}

export interface ExecuteSqlTransformInput<TSqlDialect extends SqlDialect = SqlDialect> {
  /** The source versions read. The lineage the provider records is resolved through them. */
  readonly sources: Readonly<Record<string, SqlTransformSource>>
  readonly sql: SqlTransformBody<TSqlDialect>
  readonly target: DatasetDefinition
  readonly mode: DatasetWriteMode
  readonly producer?: DatasetProducer
  /** Atomic target version guard; null requires that no version exists. */
  readonly expectedLatestVersionId?: string | null
  readonly commitMessage?: string
}

export interface PreviewSqlTransformInput<TSqlDialect extends SqlDialect = SqlDialect> {
  readonly sources: Readonly<Record<string, SqlTransformSource>>
  readonly sql: SqlTransformBody<TSqlDialect>
  readonly limit?: number
}

export interface SqlTransformSource {
  readonly dataset: DatasetDefinition
  readonly versionId?: string
  /** Columns the transform may read, in order. Every column of the dataset when omitted. */
  readonly columns?: readonly string[]
}

export interface AnalyzeSqlTransformInput<TSqlDialect extends SqlDialect = SqlDialect> {
  readonly sources: Readonly<Record<string, AnalyzeSqlTransformSource>>
  readonly sql: SqlTransformBody<TSqlDialect>
}

export interface AnalyzeSqlTransformSource {
  readonly dataset: DatasetDefinition
  /** Columns the transform may read, in order. Every column of the dataset when omitted. */
  readonly columns?: readonly string[]
}

export type SqlTransformAnalysis =
  | { readonly supported: true; readonly lineage: SqlTransformLineage }
  /** The provider could not analyze this SQL exactly; `reason` names the construct. */
  | { readonly supported: false; readonly reason: string }

/** Lineage of one transform, by source name. Same semantics as `DatasetColumnLineage`. */
export interface SqlTransformLineage {
  readonly rows: readonly SqlTransformColumnRef[]
  readonly columns: Readonly<Record<string, readonly SqlTransformColumnRef[]>>
}

export interface SqlTransformColumnRef {
  /** Source name, as passed in `sources`. */
  readonly source: string
  readonly column: string
}

export interface SqlTransformRelation {
  toString(): string
}

export type SqlTransformBody<_TSqlDialect extends SqlDialect = SqlDialect> = (
  relations: Readonly<Record<string, SqlTransformRelation>>
) => string

export function isSqlDialect(value: unknown): value is SqlDialect {
  return typeof value === "string" && SQL_DIALECTS.includes(value as SqlDialect)
}
