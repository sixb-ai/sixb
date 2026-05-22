import type { DatasetDefinition } from "../datasets"
import type {
  DatasetProducer,
  DatasetRow,
  DatasetVersion,
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
  execute(input: ExecuteSqlTransformInput<TSqlDialect>): Promise<DatasetVersion>
}

export interface LakeSqlTransformCapabilities {
  readonly preview: boolean
  readonly supportsAppend: boolean
  readonly supportsSnapshot: boolean
}

export interface ExecuteSqlTransformInput<TSqlDialect extends SqlDialect = SqlDialect> {
  readonly sources: Readonly<Record<string, SqlTransformSource>>
  readonly sql: SqlTransformBody<TSqlDialect>
  readonly target: DatasetDefinition
  readonly mode: DatasetWriteMode
  readonly producer?: DatasetProducer
  readonly expectedLatestVersionId?: string
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
