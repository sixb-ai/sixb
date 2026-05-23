import type { SQL } from "bun"

type PgRunListTable =
  | "pipeline_runs"
  | "pipeline_step_runs"
  | "webhook_runs"
  | "workflow_runs"
  | "workflow_node_runs"

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
  }
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
    whereClauses.push(`started_at >= $${nextIndex++}`)
    params.push(input.startedAfter)
  }

  if (input.startedBefore) {
    whereClauses.push(`started_at <= $${nextIndex++}`)
    params.push(input.startedBefore)
  }

  return nextIndex
}

export async function queryRunList<TRow>(input: {
  readonly sql: SQL
  readonly tableName: PgRunListTable
  readonly whereClauses: readonly string[]
  readonly params: readonly unknown[]
  readonly nextIndex: number
  readonly order?: "asc" | "desc"
  readonly limit?: number
  readonly offset?: number
}): Promise<{ readonly rows: readonly TRow[]; readonly total: number; readonly hasMore: boolean }> {
  const where = `WHERE ${input.whereClauses.join(" AND ")}`
  const order = input.order === "asc" ? "ASC" : "DESC"
  const offset = input.offset ?? 0

  const [totalRow] = (await input.sql.unsafe(
    `SELECT COUNT(*)::bigint AS count FROM ${input.tableName} ${where}`,
    [...input.params]
  )) as { count: string | number }[]

  const queryParams = [...input.params]
  let query = `
    SELECT * FROM ${input.tableName}
    ${where}
    ORDER BY started_at ${order}, id ${order}
  `
  let nextIndex = input.nextIndex

  if (input.limit !== undefined) {
    query += ` LIMIT $${nextIndex++} OFFSET $${nextIndex++}`
    queryParams.push(input.limit, offset)
  } else if (offset > 0) {
    query += ` OFFSET $${nextIndex++}`
    queryParams.push(offset)
  }

  const rows = (await input.sql.unsafe(query, queryParams)) as TRow[]
  const total = Number(totalRow?.count ?? 0)

  return {
    rows,
    total,
    hasMore: offset + rows.length < total,
  }
}
