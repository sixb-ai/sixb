import type { SQLClient, SqlParameter } from "./pg-client"

type PgLatestRunTarget =
  | { readonly tableName: "pipeline_runs"; readonly ownerColumn: "pipeline_id" }
  | { readonly tableName: "projection_runs"; readonly ownerColumn: "projection_id" }
  | { readonly tableName: "sync_runs"; readonly ownerColumn: "sync_id" }
  | { readonly tableName: "workflow_runs"; readonly ownerColumn: "workflow_id" }

type PgLatestRunSelectList = "*" | "*, checkpoint IS NOT NULL AS checkpoint_present"

export async function queryLatestRunsByOwnerId<TRow>(
  input: {
    readonly sql: SQLClient
    readonly ownerIds: readonly string[]
    readonly projectId: string
    readonly ownerIdFor: (row: TRow) => string
    readonly selectList?: PgLatestRunSelectList
    /** A status that never counts as the latest run, such as a run made stale by a newer one. */
    readonly excludedStatus?: string
    /** One more condition a row must meet to count. `bind` adds a parameter, named as it returns. */
    readonly filter?: (bind: (value: SqlParameter) => string) => string
  } & PgLatestRunTarget
): Promise<readonly TRow[]> {
  const ownerIds = [...new Set(input.ownerIds)]
  if (ownerIds.length === 0) {
    return []
  }

  const placeholders = ownerIds.map((_, index) => `$${index + 2}`).join(", ")
  const parameters: SqlParameter[] = [input.projectId, ...ownerIds]
  let statusFilter = ""
  if (input.excludedStatus !== undefined) {
    parameters.push(input.excludedStatus)
    statusFilter = ` AND status <> $${parameters.length}`
  }
  const bind = (value: SqlParameter) => {
    parameters.push(value)
    return `$${parameters.length}`
  }
  const filter = input.filter === undefined ? "" : ` AND ${input.filter(bind)}`
  const orderColumn =
    input.tableName === "sync_runs" ||
    input.tableName === "pipeline_runs" ||
    input.tableName === "projection_runs"
      ? "COALESCE(started_at, queued_at)"
      : "started_at"
  const rows = await input.sql.unsafe<TRow[]>(
    `
      SELECT DISTINCT ON (${input.ownerColumn}) ${input.selectList ?? "*"}
      FROM ${input.tableName}
      WHERE project_id = $1 AND ${input.ownerColumn} IN (${placeholders})${statusFilter}${filter}
      ORDER BY ${input.ownerColumn}, ${orderColumn} DESC, id DESC
    `,
    parameters
  )

  const latestByOwnerId = new Map(rows.map((row) => [input.ownerIdFor(row), row]))

  return ownerIds.flatMap((ownerId) => {
    const row = latestByOwnerId.get(ownerId)
    return row ? [row] : []
  })
}
