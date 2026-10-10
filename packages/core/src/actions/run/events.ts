import type { DomainEventLog } from "../../events"
import type { ActionRunRecord } from "../../storage"
import type { ActionRunResult } from "./types"

/** Announce a run once it is durable, before it executes. */
export async function emitActionRequested(
  events: DomainEventLog,
  run: ActionRunRecord,
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

/** Announce the outcome of a run this process executed. */
export async function emitActionTerminal(
  events: DomainEventLog,
  result: Exclude<ActionRunResult, { readonly skipped: true }>,
  correlationId: string
): Promise<void> {
  const finishedAt = result.finishedAt.toISOString()

  await events.emit(
    {
      events:
        result.status === "succeeded"
          ? [
              {
                type: "action.completed",
                idempotencyKey: `action.completed:${result.id}`,
                payload: {
                  actionId: result.actionId,
                  runId: result.id,
                  subject: result.subject,
                  finishedAt,
                },
              },
            ]
          : [
              {
                type: "action.failed",
                idempotencyKey: `action.failed:${result.id}`,
                payload: {
                  actionId: result.actionId,
                  runId: result.id,
                  subject: result.subject,
                  error: result.error,
                  finishedAt,
                },
              },
            ],
      correlationId,
    },
    { source: "Sixb" }
  )
}
