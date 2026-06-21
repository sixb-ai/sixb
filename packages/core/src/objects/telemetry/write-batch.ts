/**
 * Low-level write: append pre-built telemetry events and project them into storage.
 *
 * Shared by both the batch operation and per-property appenders in ObjectByIdHandle.
 */
import { assertPrivileged } from "../../authorization"
import type { NewDomainEvent, StoredTelemetryAppendedEvent } from "../../events"
import type { ResolvedObjectContext } from "../context"

export async function writeTelemetryBatch(
  ctx: Pick<ResolvedObjectContext, "events" | "storage" | "authorization">,
  events: readonly NewDomainEvent[]
): Promise<readonly StoredTelemetryAppendedEvent[]> {
  assertPrivileged(ctx, "appendTelemetry")
  const { events: eventsRuntime, storage } = ctx
  const appended = await eventsRuntime.append({ events })
  const telemetryEvents = appended.filter(
    (e): e is StoredTelemetryAppendedEvent => e.type === "telemetry.appended"
  )
  await storage.timeseries.applyTelemetryAppendedBatch(telemetryEvents)
  await storage.objects.applyTelemetryAppendedBatch(telemetryEvents)
  return telemetryEvents
}
