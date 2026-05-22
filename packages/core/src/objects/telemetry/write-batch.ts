/**
 * Low-level write: append pre-built telemetry events and project them into storage.
 *
 * Shared by both the batch operation and per-property appenders in ObjectByIdHandle.
 */
import type { NewDomainEvent, StoredTelemetryAppendedEvent } from "../../events"
import type { ResolvedObjectContext } from "../context"

export async function writeTelemetryBatch(
  ctx: Pick<ResolvedObjectContext, "events" | "storage">,
  events: readonly NewDomainEvent[]
): Promise<readonly StoredTelemetryAppendedEvent[]> {
  const { events: eventsRuntime, storage } = ctx
  const appended = await eventsRuntime.append({ events })
  const telemetryEvents = appended.filter(
    (e): e is StoredTelemetryAppendedEvent => e.type === "telemetry.appended"
  )
  await storage.timeseries.applyTelemetryAppendedBatch(telemetryEvents)
  await storage.objects.applyTelemetryAppendedBatch(telemetryEvents)
  return telemetryEvents
}
