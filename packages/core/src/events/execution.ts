import { assertPrivileged, canViewEvent } from "../authorization"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import { readerClearance, readerEventOriginClearance } from "../execution/authorized-object-reader"
import { redactDomainEvent } from "../objects/clearance-redaction"
import type { PropertyClearance } from "../objects/property-clearance"
import type { SixbRuntimeContext } from "../runtime/types"
import type { EventOriginRef } from "../security/applied-markings-contribution"
import type {
  EventsAppendInput,
  EventsEmitOptions,
  EventsReadInput,
  EventsSubscribeInput,
} from "./service"
import type { StoredDomainEvent } from "./types"

export interface EventsRuntime {
  /**
   * The events this execution may read, in order: hidden events are dropped, the others redacted.
   * Markings apply as they are now. An object event a projection emitted holds the values of the
   * dataset version it projected, so the markings that version carries apply to it too.
   */
  visible(events: readonly StoredDomainEvent[]): Promise<readonly StoredDomainEvent[]>
  append(input: EventsAppendInput): Promise<readonly StoredDomainEvent[]>
  emit(input: EventsAppendInput, options: EventsEmitOptions): Promise<void>
  read(input?: EventsReadInput): Promise<readonly StoredDomainEvent[]>
  latestCursor(): Promise<string | undefined>
  /**
   * Deliver the events this execution may read as they are appended. A batch whose markings cannot
   * be enforced, because the versions projections applied cannot be read, is dropped with a
   * warning: read it again with `read({ afterCursor })`.
   */
  subscribe(
    input: EventsSubscribeInput,
    handler: (events: readonly StoredDomainEvent[]) => unknown
  ): Promise<() => void>
}

export function createEventsRuntime(runtime: SixbRuntimeContext): EventsRuntime {
  const authority = resolveRuntimeAuthorizationForProject(runtime)
  const visible = async (
    events: readonly StoredDomainEvent[]
  ): Promise<readonly StoredDomainEvent[]> => {
    switch (authority.type) {
      case "denied":
      case "delegated":
        return []
      case "unrestricted":
        return events
      case "principal": {
        const context = authority.context
        const viewable = events.filter((event) => canViewEvent(context, event))
        if (viewable.length === 0) return viewable
        // One clearance per batch, and per origin version: the applied markings they read are
        // shared by the whole batch.
        const reader = runtime.objectReader
        const clearance = await readerClearance(reader)
        const byOrigin = new Map<string, PropertyClearance | undefined>()
        const reading: Promise<unknown>[] = []
        for (const event of viewable) {
          const origin = projectionOrigin(event)
          if (!origin || byOrigin.has(origin.key)) continue
          const resolved = readerEventOriginClearance(reader, origin.ref)
          byOrigin.set(origin.key, undefined)
          if (!(resolved instanceof Promise)) byOrigin.set(origin.key, resolved)
          else reading.push(resolved.then((value) => byOrigin.set(origin.key, value)))
        }
        await Promise.all(reading)
        return viewable.flatMap((event) => {
          if (clearance && readsUnreadable(event, clearance)) return []
          const origin = projectionOrigin(event)
          const redacting = origin ? byOrigin.get(origin.key) : clearance
          return [redacting ? redactDomainEvent(event, redacting) : event]
        })
      }
    }
  }

  return {
    visible,
    append: (input) => {
      assertPrivileged(runtime, "events.append")
      return runtime.events.append(input)
    },
    emit: (input, options) => {
      assertPrivileged(runtime, "events.emit")
      return runtime.events.emit(input, options)
    },
    read: async (input) => {
      switch (authority.type) {
        case "denied":
        case "delegated":
          return []
        case "principal":
        case "unrestricted":
          break
      }
      return visible(await runtime.events.read(input))
    },
    latestCursor: () => {
      switch (authority.type) {
        case "denied":
        case "delegated":
          return Promise.resolve(undefined)
        case "principal":
        case "unrestricted":
          return runtime.events.latestCursor()
      }
    },
    subscribe: (input, handler) => {
      switch (authority.type) {
        case "denied":
        case "delegated":
          return Promise.resolve(() => {})
        case "principal":
        case "unrestricted":
          break
      }
      return runtime.events.subscribe(input, async (events) => {
        let shown: readonly StoredDomainEvent[]
        try {
          shown = await visible(events)
        } catch (error) {
          // Fail closed. Delivery is live and keeps no progress, and a handler error is not a
          // negative acknowledgement, so the batch is dropped and reported rather than retried.
          const message = error instanceof Error ? error.message : String(error)
          console.warn(
            `[Sixb] Dropped ${events.length} event(s) from cursor '${events[0]?.cursor}' of a subscription, whose markings could not be enforced: ${message}`
          )
          return
        }
        if (shown.length > 0) return handler(shown)
      })
    },
  }
}

/**
 * The dataset version an object event's values came from, when a projection emitted it.
 *
 * The values of a property it changed came from that version; the `before` values of its
 * `propertyChanges` came from the version before, but are read under this one.
 */
function projectionOrigin(
  event: StoredDomainEvent
): { readonly key: string; readonly ref: EventOriginRef } | undefined {
  if (event.topic !== "objects" || event.origin?.kind !== "projection") return undefined
  const { projectionId, datasetId, datasetVersionId } = event.origin
  const ref = {
    projectionId,
    datasetId,
    datasetVersionId,
    objectTypeId: event.payload.objectTypeId,
  }
  return { key: JSON.stringify(Object.values(ref)), ref }
}

/**
 * Whether the event is about an object type or a link the reader cannot read: it reveals ids and
 * keys, so it is not delivered, as for a type the reader has no view grant for.
 */
function readsUnreadable(event: StoredDomainEvent, clearance: PropertyClearance): boolean {
  switch (event.topic) {
    case "objects":
    case "telemetry":
      return clearance.unreadableType(event.payload.objectTypeId) !== undefined
    case "links":
      return (
        clearance.unreadableType(event.payload.sourceTypeId) !== undefined ||
        clearance.unreadableType(event.payload.targetTypeId) !== undefined ||
        clearance.unreadableLink(event.payload.sourceTypeId, event.payload.linkId) !== undefined
      )
    default:
      return false
  }
}
