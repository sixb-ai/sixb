import { randomUUID } from "node:crypto"
import type { DatasetColumnDefinition, DatasetDefinition } from "@sixb/core"
import {
  LakeStorageError,
  type SqlTransformBody,
  type SqlTransformRelation,
} from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { encodeDatasetTableName } from "./names"
import { qualifiedTableName, quoteIdentifier } from "./sql"
import { parseVersionId } from "./versions"

const RELATION_PLACEHOLDER_PREFIX = "__sixb_sql_transform_relation_"
const RELATION_PLACEHOLDER_PATTERN = /__sixb_sql_transform_relation_[0-9a-f]{32}_[0-9]+__/g

export interface DuckLakeSqlTransformSourceRelation {
  readonly datasetId: string
  readonly versionId: string
  /** The only columns the transform may read, in order. Every column when omitted. */
  readonly columns?: readonly string[]
}

/**
 * The SQL a transform body returned, with a placeholder where each source relation belongs. The
 * body runs once; the same SQL then renders against the lake and against the lineage analysis.
 */
export interface DuckLakeSqlTransformTemplate {
  /** Replaces each placeholder with its source's relation SQL, keyed by source name. */
  render(relations: ReadonlyMap<string, string>): string
}

class DuckLakeSqlTransformRelation implements SqlTransformRelation {
  constructor(private readonly placeholder: string) {}

  toString(): string {
    return this.placeholder
  }
}

export function createDuckLakeSqlTransformTemplate(
  sourceNames: readonly string[],
  body: SqlTransformBody<"duckdb">
): DuckLakeSqlTransformTemplate {
  const token = randomUUID().replaceAll("-", "")
  const relations: Record<string, SqlTransformRelation> = Object.create(null)
  const sourceNamesByPlaceholder = new Map<string, string>()

  sourceNames.forEach((sourceName, index) => {
    const placeholder = `${RELATION_PLACEHOLDER_PREFIX}${token}_${index}__`
    relations[sourceName] = Object.freeze(new DuckLakeSqlTransformRelation(placeholder))
    sourceNamesByPlaceholder.set(placeholder, sourceName)
  })

  const sql = body(Object.freeze(relations))
  if (typeof sql !== "string") {
    throw new LakeStorageError("[SixbDuckLake] SQL transform body must return a SQL string.")
  }

  return {
    render(relationSql) {
      const rendered = sql.replace(RELATION_PLACEHOLDER_PATTERN, (placeholder) => {
        const sourceName = sourceNamesByPlaceholder.get(placeholder)
        const relation = sourceName === undefined ? undefined : relationSql.get(sourceName)
        if (relation === undefined) {
          throwUnresolvedPlaceholder()
        }

        return relation
      })

      if (rendered.includes(RELATION_PLACEHOLDER_PREFIX)) {
        throwUnresolvedPlaceholder()
      }

      return rendered
    },
  }
}

/** Each source as DuckLake time travel to its resolved version. */
export function renderDuckLakeSourceRelations(
  options: Pick<DuckLakeStorageOptions, "alias">,
  sources: Readonly<Record<string, DuckLakeSqlTransformSourceRelation>>
): ReadonlyMap<string, string> {
  return new Map(
    Object.entries(sources).map(([sourceName, source]) => {
      const snapshotId = parseVersionId(source.versionId)
      const table = qualifiedTableName(options, encodeDatasetTableName(source.datasetId))
      return [
        sourceName,
        renderSourceRelation(`${table} AT (VERSION => ${snapshotId})`, source.columns),
      ]
    })
  )
}

/**
 * The shape of every source relation. A pick lists its columns, so the transform cannot read any
 * other column of the source.
 */
export function renderSourceRelation(tableSql: string, columns?: readonly string[]): string {
  const columnsSql =
    columns === undefined ? "*" : columns.map((column) => quoteIdentifier(column)).join(", ")
  return `(SELECT ${columnsSql} FROM ${tableSql})`
}

/** The columns a source exposes to a transform: its pick, in order, or every column. */
export function pickSourceColumns(
  sourceName: string,
  dataset: DatasetDefinition,
  columns?: readonly string[]
): readonly DatasetColumnDefinition[] {
  if (columns === undefined) {
    return dataset.schema.columns
  }

  if (columns.length === 0) {
    throw new LakeStorageError(
      `[SixbDuckLake] SQL transform source '${sourceName}' must pick at least one column.`
    )
  }

  const columnsByName = new Map(dataset.schema.columns.map((column) => [column.name, column]))
  const picked = new Set<string>()

  return columns.map((columnName) => {
    const column = columnsByName.get(columnName)
    if (column === undefined) {
      throw new LakeStorageError(
        `[SixbDuckLake] SQL transform source '${sourceName}' picks column '${columnName}', which dataset '${dataset.id}' does not have.`
      )
    }

    if (picked.has(columnName)) {
      throw new LakeStorageError(
        `[SixbDuckLake] SQL transform source '${sourceName}' picks column '${columnName}' more than once.`
      )
    }

    picked.add(columnName)
    return column
  })
}

function throwUnresolvedPlaceholder(): never {
  throw new LakeStorageError(
    "[SixbDuckLake] SQL transform contains an unresolved relation placeholder."
  )
}
