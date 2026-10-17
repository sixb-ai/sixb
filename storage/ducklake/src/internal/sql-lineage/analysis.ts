import { randomUUID } from "node:crypto"
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api"
import type { DatasetColumnDefinition } from "@sixb/core"
import type {
  AnalyzeSqlTransformSource,
  SqlTransformColumnRef,
  SqlTransformLineage,
} from "@sixb/core/lake-storage"
import { datasetColumnToDuckDbSql } from "../schema"
import { quoteIdentifier, quoteSqlString } from "../sql"
import {
  type DuckLakeSqlTransformTemplate,
  pickSourceColumns,
  renderSourceRelation,
} from "../sql-transform-relations"
import { parseSerializerOutput } from "./plan-json"
import { type PlanSourceTables, planLineage } from "./plan-walker"
import { rejectPlanFormat } from "./rejection"
import { assertSingleSelect, readsOnlySources } from "./statement-gate"

interface AnalyzeSqlTransformLineageInput {
  readonly sources: Readonly<Record<string, AnalyzeSqlTransformSource>>
  readonly template: DuckLakeSqlTransformTemplate
}

/**
 * `SqlTransformAnalysis` with the result's column names in order, which the lineage record cannot
 * carry: object keys that look like integers enumerate first.
 */
export type SqlLineageAnalysis =
  | {
      readonly supported: true
      readonly lineage: SqlTransformLineage
      readonly outputColumns: readonly string[]
    }
  | { readonly supported: false; readonly reason: string; readonly readsOnlySources: boolean }

interface AnalyzedSql {
  readonly lineage: SqlTransformLineage
  readonly outputColumns: readonly string[]
}

/** An empty table standing in for one source, under a name the transform cannot guess. */
interface AnalysisTable {
  readonly sourceName: string
  readonly tableName: string
  readonly columns: readonly DatasetColumnDefinition[]
  readonly relationSql: string
}

/**
 * No file, network, extension, or setting is reachable from the analysis instance; the transform
 * only binds against its sources' empty tables.
 */
const ISOLATED_INSTANCE_CONFIG = {
  enable_external_access: "false",
  autoinstall_known_extensions: "false",
  autoload_known_extensions: "false",
}

/**
 * Column lineage of a SQL transform, derived without reading any data.
 *
 * A fresh in-memory DuckDB instance creates one empty table per source from its column schema,
 * the transform renders against those tables in the same relation shape it runs with on the lake,
 * and DuckDB binds it. The bound, unoptimized plan is then walked operator by operator. Whatever
 * the walker does not understand exactly is rejected rather than guessed; a rejection or a bind
 * error is an unsupported analysis, while an invalid source pick throws. An unsupported analysis
 * of SQL that parsed still says whether its parse tree reads anything but the sources.
 */
export async function analyzeSqlTransformLineage(
  input: AnalyzeSqlTransformLineageInput
): Promise<SqlLineageAnalysis> {
  const tables = analysisTables(input.sources)
  const sql = input.template.render(
    new Map(tables.map((table) => [table.sourceName, table.relationSql]))
  )

  try {
    return await withAnalysisConnection(tables, async (connection) => {
      const statements = await serialize(
        connection,
        `json_serialize_sql(${quoteSqlString(sql)}, skip_null := false, skip_empty := false)`,
        "statements",
        "DuckDB could not parse the transform"
      )

      try {
        return { supported: true, ...(await analyzeSql(connection, sql, statements, tables)) }
      } catch (error) {
        const sourceTables = new Set(tables.map((table) => table.tableName))
        const functions = await builtinFunctions(connection).catch(() => undefined)
        return unsupported(
          error,
          functions !== undefined && readsOnlySources(statements, sourceTables, functions)
        )
      }
    })
  } catch (error) {
    return unsupported(error, false)
  }
}

/** The functions DuckDB defines, the same in every fresh instance: read from the first one. */
let builtins: Promise<ReadonlySet<string>> | undefined

function builtinFunctions(connection: DuckDBConnection): Promise<ReadonlySet<string>> {
  if (builtins) return builtins

  const read = connection
    .runAndReadAll("SELECT DISTINCT lower(function_name) FROM duckdb_functions()")
    .then((reader) => new Set(reader.getRows().map(([name]) => String(name))))

  // A failed read is not kept: the next analysis reads again.
  builtins = read
  read.catch(() => {
    if (builtins === read) builtins = undefined
  })
  return read
}

function unsupported(error: unknown, readsOnlySources: boolean): SqlLineageAnalysis {
  return {
    supported: false,
    reason: error instanceof Error ? error.message : String(error),
    readsOnlySources,
  }
}

function analysisTables(
  sources: Readonly<Record<string, AnalyzeSqlTransformSource>>
): readonly AnalysisTable[] {
  const token = randomUUID().replaceAll("-", "")

  return Object.entries(sources).map(([sourceName, source], index) => {
    const tableName = `sixb_lineage_${token}_${index}`
    return {
      sourceName,
      tableName,
      columns: pickSourceColumns(sourceName, source.dataset, source.columns),
      relationSql: renderSourceRelation(quoteIdentifier(tableName), source.columns),
    }
  })
}

async function withAnalysisConnection<T>(
  tables: readonly AnalysisTable[],
  use: (connection: DuckDBConnection) => Promise<T>
): Promise<T> {
  const instance = await DuckDBInstance.create(":memory:", ISOLATED_INSTANCE_CONFIG)
  try {
    const connection = await instance.connect()
    try {
      for (const table of tables) {
        const columnsSql = table.columns.map((column) => datasetColumnToDuckDbSql(column))
        await connection.run(
          `CREATE TABLE ${quoteIdentifier(table.tableName)} (${columnsSql.join(", ")})`
        )
      }

      // The transform cannot loosen the restrictions above through SET or a setting function.
      await connection.run("SET lock_configuration = true")
      return await use(connection)
    } finally {
      connection.closeSync()
    }
  } finally {
    instance.closeSync()
  }
}

async function analyzeSql(
  connection: DuckDBConnection,
  sql: string,
  statements: readonly unknown[],
  tables: readonly AnalysisTable[]
): Promise<AnalyzedSql> {
  assertSingleSelect(statements)

  const plans = await serialize(
    connection,
    `json_serialize_plan(${quoteSqlString(sql)}, skip_null := false, skip_empty := false, optimize := false)`,
    "plans",
    "DuckDB could not bind the transform"
  )
  if (plans.length !== 1) {
    rejectPlanFormat(`expected one plan, got ${plans.length}`)
  }

  const sourceColumns = numberSourceColumns(tables)
  const lineage = planLineage(plans[0], sourceColumns.ids)
  const names = await outputColumnNames(connection, sql)
  if (lineage.columns.length !== names.length) {
    rejectPlanFormat(`the plan has ${lineage.columns.length} columns, the result ${names.length}`)
  }

  const refs = (ids: readonly number[]): SqlTransformColumnRef[] =>
    ids.map((id) => sourceColumns.refs[id])

  return {
    lineage: {
      rows: refs(lineage.rows),
      columns: Object.fromEntries(names.map((name, index) => [name, refs(lineage.columns[index])])),
    },
    outputColumns: names,
  }
}

/** Numbers every column of every table, in source then column order, for the plan walker. */
function numberSourceColumns(tables: readonly AnalysisTable[]): {
  readonly ids: PlanSourceTables
  readonly refs: readonly SqlTransformColumnRef[]
} {
  const refs: SqlTransformColumnRef[] = []
  const ids = new Map(
    tables.map((table) => {
      const columnIds = table.columns.map((column) => {
        refs.push({ source: table.sourceName, column: column.name })
        return [column.name, refs.length - 1] as const
      })
      return [table.tableName, new Map(columnIds)] as const
    })
  )

  return { ids, refs }
}

/**
 * Names as the executor materializes them: selected through a subquery, where DuckDB renames
 * duplicate output names (`id`, `id_1`).
 */
async function outputColumnNames(
  connection: DuckDBConnection,
  sql: string
): Promise<readonly string[]> {
  const prepared = await connection.prepare(`SELECT * FROM (${sql}) AS sixb_lineage_result`)
  try {
    return Array.from({ length: prepared.columnCount }, (_, index) => prepared.columnName(index))
  } finally {
    prepared.destroySync()
  }
}

async function serialize(
  connection: DuckDBConnection,
  serializerSql: string,
  listKey: string,
  failure: string
): Promise<readonly unknown[]> {
  const reader = await connection.runAndReadAll(`SELECT ${serializerSql}`)
  const text = reader.getRows()[0]?.[0]
  if (typeof text !== "string") {
    rejectPlanFormat("the serializer returned no JSON")
  }

  return parseSerializerOutput(text, listKey, failure)
}
