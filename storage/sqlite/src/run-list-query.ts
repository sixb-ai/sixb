import type { Database } from "bun:sqlite"

export type SqliteValue = string | number | null

type SqliteRunListTable =
  | "agent_runs"
  | "pipeline_runs"
  | "pipeline_step_runs"
  | "sync_runs"
  | "webhook_runs"
  | "workflow_runs"
  | "workflow_node_runs"
  | "workflow_agent_node_runs"

export function hasEmptyStatuses(input: { readonly statuses?: readonly unknown[] }): boolean {
  return input.statuses !== undefined && input.statuses.length === 0
}

type StartedAtExpression = "started_at" | "COALESCE(started_at, created_at)"

export function appendRunListFilters(
  whereClauses: string[],
  args: SqliteValue[],
  input: {
    readonly statuses?: readonly string[]
    readonly startedAfter?: Date
    readonly startedBefore?: Date
  },
  startedAtExpression: StartedAtExpression = "started_at"
): void {
  if (input.statuses) {
    if (input.statuses.length === 0) {
      whereClauses.push("1 = 0")
    } else {
      whereClauses.push(`status IN (${input.statuses.map(() => "?").join(", ")})`)
      args.push(...input.statuses)
    }
  }

  if (input.startedAfter) {
    whereClauses.push(`${startedAtExpression} >= ?`)
    args.push(input.startedAfter.toISOString())
  }

  if (input.startedBefore) {
    whereClauses.push(`${startedAtExpression} <= ?`)
    args.push(input.startedBefore.toISOString())
  }
}

export function queryRunList<TRow>(input: {
  readonly db: Database
  readonly tableName: SqliteRunListTable
  readonly whereClauses: readonly string[]
  readonly args: readonly SqliteValue[]
  readonly order?: "asc" | "desc"
  readonly limit?: number
  readonly offset?: number
}): { readonly rows: readonly TRow[]; readonly total: number; readonly hasMore: boolean } {
  const where = `WHERE ${input.whereClauses.join(" AND ")}`
  const order = input.order === "asc" ? "ASC" : "DESC"
  const offset = input.offset ?? 0

  const totalRow = input.db
    .query(`SELECT COUNT(*) AS count FROM ${input.tableName} ${where}`)
    .get(...input.args) as { count: number }

  const orderColumn =
    input.tableName === "agent_runs"
      ? "COALESCE(started_at, created_at)"
      : input.tableName === "workflow_agent_node_runs"
        ? "created_at"
        : "started_at"
  const idColumn = input.tableName === "workflow_agent_node_runs" ? "node_run_id" : "id"
  let query = `
    SELECT * FROM ${input.tableName}
    ${where}
    ORDER BY ${orderColumn} ${order}, ${idColumn} ${order}
  `
  const queryArgs = [...input.args]

  if (input.limit !== undefined) {
    query += " LIMIT ? OFFSET ?"
    queryArgs.push(input.limit, offset)
  } else if (offset > 0) {
    query += " LIMIT -1 OFFSET ?"
    queryArgs.push(offset)
  }

  const rows = input.db.query(query).all(...queryArgs) as TRow[]
  const total = totalRow.count

  return {
    rows,
    total,
    hasMore: offset + rows.length < total,
  }
}
