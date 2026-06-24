import type { Database } from "bun:sqlite"
import type { SqliteValue } from "./run-list-query"

type SqliteLatestRunTarget =
  | { readonly tableName: "pipeline_runs"; readonly ownerColumn: "pipeline_id" }
  | { readonly tableName: "projection_runs"; readonly ownerColumn: "projection_id" }
  | { readonly tableName: "sync_runs"; readonly ownerColumn: "sync_id" }
  | { readonly tableName: "workflow_runs"; readonly ownerColumn: "workflow_id" }

export function queryLatestRunsByOwnerId<TRow>(
  input: {
    readonly db: Database
    readonly ownerIds: readonly string[]
    readonly projectId: string
    readonly ownerIdFor: (row: TRow) => string
  } & SqliteLatestRunTarget
): readonly TRow[] {
  const ownerIds = [...new Set(input.ownerIds)]
  if (ownerIds.length === 0) {
    return []
  }

  const placeholders = ownerIds.map(() => "?").join(", ")
  const rows = input.db
    .query(
      `
        SELECT *
        FROM (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY ${input.ownerColumn}
              ORDER BY started_at DESC, id DESC
            ) AS sixb_latest_rank
          FROM ${input.tableName}
          WHERE project_id = ? AND ${input.ownerColumn} IN (${placeholders})
        )
        WHERE sixb_latest_rank = 1
      `
    )
    .all(input.projectId, ...ownerIds) as (TRow & { sixb_latest_rank: SqliteValue })[]

  const latestByOwnerId = new Map(rows.map((row) => [input.ownerIdFor(row), row]))

  return ownerIds.flatMap((ownerId) => {
    const row = latestByOwnerId.get(ownerId)
    return row ? [row] : []
  })
}
