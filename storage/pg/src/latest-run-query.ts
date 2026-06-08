import type { SQL, SqlParameter } from "./pg-client"

type PgLatestRunTarget =
  | { readonly tableName: "pipeline_runs"; readonly ownerColumn: "pipeline_id" }
  | { readonly tableName: "sync_runs"; readonly ownerColumn: "sync_id" }
  | { readonly tableName: "workflow_runs"; readonly ownerColumn: "workflow_id" }

type PgLatestRunSelectList = "*" | "*, checkpoint IS NOT NULL AS checkpoint_present"

export async function queryLatestRunsByOwnerId<TRow>(
  input: {
    readonly sql: SQL
    readonly ownerIds: readonly string[]
    readonly projectId: string
    readonly ownerIdFor: (row: TRow) => string
    readonly selectList?: PgLatestRunSelectList
  } & PgLatestRunTarget
): Promise<readonly TRow[]> {
  const ownerIds = [...new Set(input.ownerIds)]
  if (ownerIds.length === 0) {
    return []
  }

  const placeholders = ownerIds.map((_, index) => `$${index + 2}`).join(", ")
  const rows = await input.sql.unsafe<TRow[]>(
    `
      SELECT DISTINCT ON (${input.ownerColumn}) ${input.selectList ?? "*"}
      FROM ${input.tableName}
      WHERE project_id = $1 AND ${input.ownerColumn} IN (${placeholders})
      ORDER BY ${input.ownerColumn}, started_at DESC, id DESC
    `,
    [input.projectId, ...ownerIds] as SqlParameter[]
  )

  const latestByOwnerId = new Map(rows.map((row) => [input.ownerIdFor(row), row]))

  return ownerIds.flatMap((ownerId) => {
    const row = latestByOwnerId.get(ownerId)
    return row ? [row] : []
  })
}
