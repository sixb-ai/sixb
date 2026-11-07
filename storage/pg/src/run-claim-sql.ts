import { type ClaimableRun, laterLease, planRunClaim } from "@sixb/core/internal/storage"
import type {
  ClaimRunInput,
  ConfirmRunExecutionInput,
  ReleaseRunExecutionInput,
  RunClaim,
  RunExecution,
} from "@sixb/core/storage"
import type { PgStoreClient } from "./transactions"

/** The columns every recoverable run keeps, whichever table holds it. */
export interface PgRunExecutionColumns {
  readonly attempt: number | string
  readonly execution_token: string | null
  readonly execution_queue_lease_expires_at: Date | string | null
}

/** One table of recoverable runs. Only its name, and how a row reads, differ between primitives. */
export interface PgRunTable<TRow extends PgRunExecutionColumns, TRun> {
  readonly name: "sync_runs" | "pipeline_runs" | "workflow_runs"
  readonly returning: string
  toRun(row: TRow): TRun
  notFound(projectId: string, id: string): Error
  staleExecution(id: string): Error
}

export function pgRunExecutionFields(row: PgRunExecutionColumns): {
  readonly attempt: number
  readonly execution: RunExecution | undefined
} {
  return {
    attempt: Number(row.attempt),
    execution:
      row.execution_token && row.execution_queue_lease_expires_at
        ? {
            token: row.execution_token,
            queueLeaseExpiresAt: new Date(row.execution_queue_lease_expires_at),
          }
        : undefined,
  }
}

export async function lockPgRun<TRow extends PgRunExecutionColumns, TRun>(
  tx: PgStoreClient,
  table: PgRunTable<TRow, TRun>,
  projectId: string,
  id: string
): Promise<TRun> {
  const [row] = await tx.unsafe<TRow[]>(
    `SELECT ${table.returning} FROM ${table.name} WHERE project_id = $1 AND id = $2 FOR UPDATE`,
    [projectId, id]
  )
  if (!row) throw table.notFound(projectId, id)

  return table.toRun(row)
}

/** `sibling` is a run this one must not overlap, read in the same transaction. */
export async function claimPgRun<TRow extends PgRunExecutionColumns, TRun extends ClaimableRun>(
  tx: PgStoreClient,
  table: PgRunTable<TRow, TRun>,
  input: ClaimRunInput,
  sibling?: ClaimableRun
): Promise<RunClaim<TRun>> {
  const existing = await lockPgRun(tx, table, input.projectId, input.id)

  const plan = planRunClaim(existing, input, sibling)
  if (!plan.take) return plan.claim

  const [updated] = await tx.unsafe<TRow[]>(
    `UPDATE ${table.name}
     SET status = 'running', started_at = $1, attempt = $2, execution_token = $3,
         execution_queue_lease_expires_at = $4, error = NULL
     WHERE project_id = $5 AND id = $6
     RETURNING ${table.returning}`,
    [
      plan.startedAt,
      plan.attempt,
      plan.execution.token,
      plan.execution.queueLeaseExpiresAt,
      input.projectId,
      input.id,
    ]
  )
  if (!updated) throw table.notFound(input.projectId, input.id)

  return { outcome: plan.outcome, run: table.toRun(updated) }
}

export async function lockHeldPgRun<TRow extends PgRunExecutionColumns, TRun extends ClaimableRun>(
  tx: PgStoreClient,
  table: PgRunTable<TRow, TRun>,
  input: { readonly projectId: string; readonly id: string; readonly executionToken: string }
): Promise<TRun> {
  const run = await lockPgRun(tx, table, input.projectId, input.id)
  if (run.status !== "running" || run.execution?.token !== input.executionToken) {
    throw table.staleExecution(input.id)
  }

  return run
}

export async function confirmPgRunExecution<
  TRow extends PgRunExecutionColumns,
  TRun extends ClaimableRun,
>(
  tx: PgStoreClient,
  table: PgRunTable<TRow, TRun>,
  input: ConfirmRunExecutionInput
): Promise<TRun> {
  const existing = await lockHeldPgRun(tx, table, input)

  const [updated] = await tx.unsafe<TRow[]>(
    `UPDATE ${table.name} SET execution_queue_lease_expires_at = $1
     WHERE project_id = $2 AND id = $3
     RETURNING ${table.returning}`,
    [
      laterLease(existing.execution?.queueLeaseExpiresAt, input.queueLeaseExpiresAt),
      input.projectId,
      input.id,
    ]
  )
  if (!updated) throw table.notFound(input.projectId, input.id)

  return table.toRun(updated)
}

export async function releasePgRun(
  sql: PgStoreClient,
  table: Pick<PgRunTable<never, never>, "name">,
  input: ReleaseRunExecutionInput
): Promise<void> {
  await sql.unsafe(
    `UPDATE ${table.name}
     SET execution_queue_lease_expires_at = $1, attempt = attempt - $2
     WHERE project_id = $3 AND id = $4 AND status = 'running' AND execution_token = $5`,
    [
      input.releasedAt ?? new Date(),
      input.spentAttempt ? 0 : 1,
      input.projectId,
      input.id,
      input.executionToken,
    ]
  )
}
