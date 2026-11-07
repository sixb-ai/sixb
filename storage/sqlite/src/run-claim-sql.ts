import type { Database } from "bun:sqlite"
import { type ClaimableRun, laterLease, planRunClaim } from "@sixb/core/internal/storage"
import type {
  ClaimRunInput,
  ConfirmRunExecutionInput,
  ReleaseRunExecutionInput,
  RunClaim,
  RunExecution,
} from "@sixb/core/storage"

/** The columns every recoverable run keeps, whichever table holds it. */
export interface SqliteRunExecutionColumns {
  readonly attempt: number
  readonly execution_token: string | null
  readonly execution_queue_lease_expires_at: string | null
}

/** One table of recoverable runs. Only its name, and how a row reads, differ between primitives. */
export interface SqliteRunTable<TRow extends SqliteRunExecutionColumns, TRun> {
  readonly name: "sync_runs" | "pipeline_runs" | "workflow_runs"
  toRun(row: TRow): TRun
  notFound(projectId: string, id: string): Error
  staleExecution(id: string): Error
}

export function sqliteRunExecutionFields(row: SqliteRunExecutionColumns): {
  readonly attempt: number
  readonly execution: RunExecution | undefined
} {
  return {
    attempt: row.attempt,
    execution:
      row.execution_token && row.execution_queue_lease_expires_at
        ? {
            token: row.execution_token,
            queueLeaseExpiresAt: new Date(row.execution_queue_lease_expires_at),
          }
        : undefined,
  }
}

export function requireSqliteRun<TRow extends SqliteRunExecutionColumns, TRun>(
  db: Database,
  table: SqliteRunTable<TRow, TRun>,
  projectId: string,
  id: string
): TRun {
  const row = db
    .query(`SELECT * FROM ${table.name} WHERE project_id = ? AND id = ?`)
    .get(projectId, id) as TRow | null
  if (!row) throw table.notFound(projectId, id)

  return table.toRun(row)
}

/** `sibling` is a run this one must not overlap. */
export function claimSqliteRun<TRow extends SqliteRunExecutionColumns, TRun extends ClaimableRun>(
  db: Database,
  table: SqliteRunTable<TRow, TRun>,
  input: ClaimRunInput,
  sibling?: ClaimableRun
): RunClaim<TRun> {
  const plan = planRunClaim(requireSqliteRun(db, table, input.projectId, input.id), input, sibling)
  if (!plan.take) return plan.claim

  db.query(
    `
    UPDATE ${table.name}
    SET status = 'running', started_at = ?, attempt = ?, execution_token = ?,
        execution_queue_lease_expires_at = ?, error = NULL
    WHERE project_id = ? AND id = ?
  `
  ).run(
    plan.startedAt.toISOString(),
    plan.attempt,
    plan.execution.token,
    plan.execution.queueLeaseExpiresAt.toISOString(),
    input.projectId,
    input.id
  )

  return { outcome: plan.outcome, run: requireSqliteRun(db, table, input.projectId, input.id) }
}

export function requireHeldSqliteRun<
  TRow extends SqliteRunExecutionColumns,
  TRun extends ClaimableRun,
>(
  db: Database,
  table: SqliteRunTable<TRow, TRun>,
  input: { readonly projectId: string; readonly id: string; readonly executionToken: string }
): TRun {
  const run = requireSqliteRun(db, table, input.projectId, input.id)
  if (run.status !== "running" || run.execution?.token !== input.executionToken) {
    throw table.staleExecution(input.id)
  }

  return run
}

export function confirmSqliteRunExecution<
  TRow extends SqliteRunExecutionColumns,
  TRun extends ClaimableRun,
>(db: Database, table: SqliteRunTable<TRow, TRun>, input: ConfirmRunExecutionInput): TRun {
  const existing = requireHeldSqliteRun(db, table, input)

  db.query(
    `UPDATE ${table.name} SET execution_queue_lease_expires_at = ? WHERE project_id = ? AND id = ?`
  ).run(
    laterLease(existing.execution?.queueLeaseExpiresAt, input.queueLeaseExpiresAt).toISOString(),
    input.projectId,
    input.id
  )

  return requireSqliteRun(db, table, input.projectId, input.id)
}

export function releaseSqliteRun(
  db: Database,
  table: Pick<SqliteRunTable<never, never>, "name">,
  input: ReleaseRunExecutionInput
): void {
  db.query(
    `
    UPDATE ${table.name}
    SET execution_queue_lease_expires_at = ?, attempt = attempt - ?
    WHERE project_id = ? AND id = ? AND status = 'running' AND execution_token = ?
  `
  ).run(
    (input.releasedAt ?? new Date()).toISOString(),
    input.spentAttempt ? 0 : 1,
    input.projectId,
    input.id,
    input.executionToken
  )
}
