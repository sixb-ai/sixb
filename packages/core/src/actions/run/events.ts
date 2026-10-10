import type { DomainEventLog } from "../../events"
import type { ActionRunRecord } from "../../storage"
import type { PendingActionRun } from "./types"

/** Announce a run before it executes. */
export async function emitActionRequested(
  events: DomainEventLog,
  run: PendingActionRun,
  correlationId: string
): Promise<void> {
  await events.emit(
    {
      events: [
        {
          type: "action.requested",
          payload: {
            actionId: run.actionId,
            subject: run.subject,
            params: run.params,
            runId: run.id,
          },
        },
      ],
      correlationId,
    },
    { source: "Sixb" }
  )
}

/** Announce how a run ended, once this process recorded it. */
export async function emitActionTerminal(
  events: DomainEventLog,
  run: ActionRunRecord,
  correlationId: string
): Promise<void> {
  const finishedAt = run.finishedAt.toISOString()

  await events.emit(
    {
      events:
        run.status === "succeeded"
          ? [
              {
                type: "action.completed",
                idempotencyKey: `action.completed:${run.id}`,
                payload: {
                  actionId: run.actionId,
                  runId: run.id,
                  subject: run.subject,
                  finishedAt,
                },
              },
            ]
          : [
              {
                type: "action.failed",
                idempotencyKey: `action.failed:${run.id}`,
                payload: {
                  actionId: run.actionId,
                  runId: run.id,
                  subject: run.subject,
                  error: run.error,
                  finishedAt,
                },
              },
            ],
      correlationId,
    },
    { source: "Sixb" }
  )
}
