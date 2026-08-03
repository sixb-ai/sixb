import { randomUUID } from "node:crypto"
import { SixbError } from "@sixb/core/errors"
import type { SqlTransformBody, SqlTransformRelation } from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../types"
import { encodeDatasetTableName } from "./names"
import { qualifiedTableName } from "./sql"
import { parseVersionId } from "./versions"

const RELATION_PLACEHOLDER_PREFIX = "__sixb_sql_transform_relation_"
const RELATION_PLACEHOLDER_PATTERN = /__sixb_sql_transform_relation_[0-9a-f]{32}_[0-9]+__/g

export interface DuckLakeSqlTransformSourceRelation {
  readonly datasetId: string
  readonly versionId: string
}

export interface RenderDuckLakeSqlTransformSqlInput {
  readonly options: Pick<DuckLakeStorageOptions, "alias">
  readonly sources: Readonly<Record<string, DuckLakeSqlTransformSourceRelation>>
  readonly sql: SqlTransformBody<"duckdb">
}

interface DuckLakeSqlTransformRelationContext {
  readonly relations: Readonly<Record<string, SqlTransformRelation>>
  render(sql: string): string
}

class DuckLakeSqlTransformRelation implements SqlTransformRelation {
  constructor(private readonly placeholder: string) {}

  toString(): string {
    return this.placeholder
  }
}

export function renderDuckLakeSqlTransformSql(input: RenderDuckLakeSqlTransformSqlInput): string {
  const context = createDuckLakeSqlTransformRelationContext(input)
  const sql = input.sql(context.relations)

  if (typeof sql !== "string") {
    throw new SixbError(
      "storage.lake_failed",
      "[SixbDuckLake] SQL transform body must return a SQL string."
    )
  }

  return context.render(sql)
}

function createDuckLakeSqlTransformRelationContext(
  input: Omit<RenderDuckLakeSqlTransformSqlInput, "sql">
): DuckLakeSqlTransformRelationContext {
  const token = randomUUID().replaceAll("-", "")
  const relations: Record<string, SqlTransformRelation> = Object.create(null)
  const replacements = new Map<string, string>()

  let index = 0
  for (const [sourceName, source] of Object.entries(input.sources)) {
    const placeholder = `${RELATION_PLACEHOLDER_PREFIX}${token}_${index}__`
    relations[sourceName] = Object.freeze(new DuckLakeSqlTransformRelation(placeholder))
    replacements.set(placeholder, renderDuckLakeSourceRelation(input.options, source))
    index += 1
  }

  return {
    relations: Object.freeze(relations),
    render(sql) {
      const rendered = sql.replace(RELATION_PLACEHOLDER_PATTERN, (placeholder) => {
        const replacement = replacements.get(placeholder)
        if (replacement === undefined) {
          throwUnresolvedPlaceholder()
        }

        return replacement
      })

      if (rendered.includes(RELATION_PLACEHOLDER_PREFIX)) {
        throwUnresolvedPlaceholder()
      }

      return rendered
    },
  }
}

function renderDuckLakeSourceRelation(
  options: Pick<DuckLakeStorageOptions, "alias">,
  source: DuckLakeSqlTransformSourceRelation
): string {
  const snapshotId = parseVersionId(source.versionId)
  const tableName = encodeDatasetTableName(source.datasetId)
  return `(SELECT * FROM ${qualifiedTableName(options, tableName)} AT (VERSION => ${snapshotId}))`
}

function throwUnresolvedPlaceholder(): never {
  throw new SixbError(
    "storage.lake_failed",
    "[SixbDuckLake] SQL transform contains an unresolved relation placeholder."
  )
}
