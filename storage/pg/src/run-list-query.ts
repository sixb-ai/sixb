import type { SQLClient, SqlParameter } from "./pg-client"

type PgRunListTable =
  | "agent_runs"
  | "pipeline_runs"
  | "pipeline_step_runs"
  | "sync_runs"
  | "webhook_runs"
  | "workflow_runs"
  | "workflow_node_runs"
  | "workflow_agent_node_runs"

/** Column projection — `sync_runs` needs the derived `checkpoint_present` flag. */
type PgRunListSelectList = "*" | "*, checkpoint IS NOT NULL AS checkpoint_present"
type StartedAtExpression = "started_at" | "COALESCE(started_at, created_at)"

export function hasEmptyStatuses(input: { readonly statuses?: readonly unknown[] }): boolean {
  return input.statuses !== undefined && input.statuses.length === 0
}

export function appendRunListFilters(
  whereClauses: string[],
  params: unknown[],
  index: number,
  input: {
    readonly statuses?: readonly string[]
    readonly startedAfter?: Date
    readonly startedBefore?: Date
  },
  startedAtExpression: StartedAtExpression = "started_at"
): number {
  let nextIndex = index

  if (input.statuses) {
    if (input.statuses.length === 0) {
      whereClauses.push("1 = 0")
    } else {
      const placeholders = input.statuses.map(() => `$${nextIndex++}`)
      whereClauses.push(`status IN (${placeholders.join(", ")})`)
      params.push(...input.statuses)
    }
  }

  if (input.startedAfter) {
    whereClauses.push(`${startedAtExpression} >= $${nextIndex++}`)
    params.push(input.startedAfter)
  }

  if (input.startedBefore) {
    whereClauses.push(`${startedAtExpression} <= $${nextIndex++}`)
    params.push(input.startedBefore)
  }

  return nextIndex
}

export async function queryRunList<TRow>(input: {
  readonly sql: SQLClient
  readonly tableName: PgRunListTable
  readonly whereClauses: readonly string[]
  readonly params: readonly unknown[]
  readonly nextIndex: number
  readonly order?: "asc" | "desc"
  readonly limit?: number
  readonly offset?: number
  readonly selectList?: PgRunListSelectList
}): Promise<{ readonly rows: readonly TRow[]; readonly total: number; readonly hasMore: boolean }> {
  const where = `WHERE ${input.whereClauses.join(" AND ")}`
  const order = input.order === "asc" ? "ASC" : "DESC"
  const offset = input.offset ?? 0

  const [totalRow] = await input.sql.unsafe<{ count: string | number }[]>(
    `SELECT COUNT(*)::bigint AS count FROM ${input.tableName} ${where}`,
    [...input.params] as SqlParameter[]
  )

  const queryParams = [...input.params] as SqlParameter[]
  const orderColumn =
    input.tableName === "agent_runs"
      ? "COALESCE(started_at, created_at)"
      : input.tableName === "workflow_agent_node_runs"
        ? "created_at"
        : "started_at"
  const idColumn = input.tableName === "workflow_agent_node_runs" ? "node_run_id" : "id"
  let query = `
    SELECT ${input.selectList ?? "*"} FROM ${input.tableName}
    ${where}
    ORDER BY ${orderColumn} ${order}, ${idColumn} ${order}
  `
  let nextIndex = input.nextIndex

  if (input.limit !== undefined) {
    query += ` LIMIT $${nextIndex++} OFFSET $${nextIndex++}`
    queryParams.push(input.limit, offset)
  } else if (offset > 0) {
    query += ` OFFSET $${nextIndex++}`
    queryParams.push(offset)
  }

  const rows = await input.sql.unsafe<TRow[]>(query, queryParams)
  const total = Number(totalRow?.count ?? 0)

  return {
    rows,
    total,
    hasMore: offset + rows.length < total,
  }
}
