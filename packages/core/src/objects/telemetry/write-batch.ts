/**
 * Low-level write: append pre-built telemetry events and project them into storage.
 *
 * Shared by both the batch operation and per-property appenders in ObjectByIdHandle.
 */
import { assertPrivileged } from "../../authorization"
import type { EventDraft, StoredTelemetryAppendedEvent } from "../../events"
import type { ResolvedObjectContext } from "../context"

export async function writeTelemetryBatch(
  ctx: Pick<ResolvedObjectContext, "events" | "storage" | "authorization">,
  events: readonly EventDraft[]
): Promise<readonly StoredTelemetryAppendedEvent[]> {
  assertPrivileged(ctx, "appendTelemetry")
  const { events: eventsRuntime, storage } = ctx
  const appended = await eventsRuntime.append({ events })
  const telemetryEvents = appended.filter(
    (e): e is StoredTelemetryAppendedEvent => e.type === "telemetry.appended"
  )
  await storage.timeseries.applyTelemetryAppendedBatch(telemetryEvents)
  await storage.objects.applyTelemetryAppendedBatch(
    await latestTelemetryEventsForObjectMaterialization(ctx, telemetryEvents)
  )
  return telemetryEvents
}

async function latestTelemetryEventsForObjectMaterialization(
  ctx: Pick<ResolvedObjectContext, "storage">,
  events: readonly StoredTelemetryAppendedEvent[]
): Promise<readonly StoredTelemetryAppendedEvent[]> {
  const latestEventIds = new Set<string>()
  const groups = new Map<string, StoredTelemetryAppendedEvent>()

  for (const event of events) {
    groups.set(telemetryPropertyKey(event), event)
  }

  // The per-group lookups are independent; run them concurrently so a batch
  // touching many (object, property) groups pays one round-trip of latency
  // rather than one per group.
  const latestPoints = await Promise.all(
    [...groups.values()].map((event) =>
      ctx.storage.timeseries.getLatest({
        projectId: event.projectId,
        objectTypeId: event.payload.objectTypeId,
        objectId: event.payload.objectId,
        propertyId: event.payload.propertyId,
      })
    )
  )
  for (const latest of latestPoints) {
    if (latest?.sourceEventId) {
      latestEventIds.add(latest.sourceEventId)
    }
  }

  return events.filter((event) => latestEventIds.has(event.id))
}

function telemetryPropertyKey(event: StoredTelemetryAppendedEvent): string {
  return [
    event.projectId,
    event.payload.objectTypeId,
    event.payload.objectId,
    event.payload.propertyId,
  ].join("\0")
}
