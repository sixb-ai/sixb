import { createRuntimeArtifactAccessRule } from "../artifacts/execution"
import { type AuthorizationContext, assertPrivileged, canViewEvent } from "../authorization"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import {
  type AuthorizedObjectReader,
  readerClearance,
  readerEventClearance,
  readerViewConditions,
} from "../execution/authorized-object-reader"
import type { EventSources } from "../execution/object-reader-clearance"
import { redactDomainEvent } from "../objects/clearance-redaction"
import type { PropertyClearance } from "../objects/property-clearance"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  EventsAppendInput,
  EventsEmitOptions,
  EventsReadInput,
  EventsSubscribeInput,
} from "./service"
import type { StoredDomainEvent } from "./types"
import {
  type ObjectHistory,
  visibleUnderConditions,
  withoutHiddenPriorState,
} from "./view-conditions"

export interface EventsRuntime {
  /**
   * The events this execution may read, in order: hidden events are dropped, the others redacted.
   * Markings apply as they are now, with those of the versions an object event's values came from:
   * the version a projection's event applied, and every marking a column declares for projected
   * values that came from earlier versions.
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

  // Objects an event names that the reader cannot read: storage tells which still exist, and the
  // log what the others held. Neither answer is shown.
  const history: ObjectHistory = {
    existing: async (objects) => {
      const rows = await runtime.storage.objects.getByPrimaryIdBatch({
        projectId: runtime.projectId,
        items: objects,
      })
      return new Set(rows.keys())
    },
    lastEventBefore: (event, object) =>
      runtime.events.lastObjectEventBefore({ cursor: event.cursor, ...object }),
  }

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
        const shown = await visibleByGrants(authority.context, events)
        if (!events.some((event) => event.topic === "artifacts")) return shown

        // Artifact events go to whoever reads the artifact, in the log's order with the others.
        const readable = await readableArtifactEvents(runtime, events)
        const byCursor = new Map(shown.map((event) => [event.cursor, event]))

        return events
          .filter((event) =>
            event.topic === "artifacts" ? readable.has(event) : byCursor.has(event.cursor)
          )
          .map((event) => byCursor.get(event.cursor) ?? event)
      }
    }
  }

  /** The events a principal's grants show it, redacted as its clearance says. */
  const visibleByGrants = async (
    context: AuthorizationContext,
    events: readonly StoredDomainEvent[]
  ): Promise<readonly StoredDomainEvent[]> => {
    const reader = runtime.objectReader
    const conditions = readerViewConditions(reader)
    const viewable = events.filter((event) => canViewEvent(context, event, conditions))
    if (viewable.length === 0) return viewable

    const clearance = await readerClearance(reader)
    const clearanceFor = await eventClearances(reader, viewable, clearance)

    const readable = clearance
      ? viewable.filter((event) => !readsUnreadable(event, clearance))
      : viewable
    const shown = await visibleUnderConditions(reader, readable, conditions, clearanceFor, history)

    return shown.map((event) => {
      const redacting = clearanceFor(event)
      const redacted = redacting ? redactDomainEvent(event, redacting) : event
      return withoutHiddenPriorState(event, redacted, conditions)
    })
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
 * The artifact events the runtime's caller receives: those about an artifact it reads, as the
 * artifact access rule decides now. One read per artifact, however many of its events the batch
 * holds; without artifact storage, none.
 */
async function readableArtifactEvents(
  runtime: SixbRuntimeContext,
  events: readonly StoredDomainEvent[]
): Promise<ReadonlySet<StoredDomainEvent>> {
  const storage = runtime.storage.artifacts
  if (!storage) return new Set()

  const rule = createRuntimeArtifactAccessRule(runtime)
  const readable = new Map<string, Promise<boolean>>()
  const reads = (artifactId: string) => {
    let read = readable.get(artifactId)
    if (!read) {
      read = storage
        .get({ projectId: runtime.projectId, id: artifactId })
        .then(async (artifact) => artifact !== null && (await rule.accessTo(artifact)) !== "none")
      readable.set(artifactId, read)
    }
    return read
  }

  const shown = new Set<StoredDomainEvent>()
  for (const event of events) {
    if (event.topic === "artifacts" && (await reads(event.payload.artifactId))) shown.add(event)
  }
  return shown
}

/**
 * The clearance each event is redacted with, resolved once per kind of event for the whole batch.
 * An event that holds only values the current markings describe uses the reader's clearance.
 */
async function eventClearances(
  reader: AuthorizedObjectReader,
  events: readonly StoredDomainEvent[],
  clearance: PropertyClearance | undefined
): Promise<(event: StoredDomainEvent) => PropertyClearance | undefined> {
  const kinds = new Map<string, EventSources>()
  for (const event of events) {
    const kind = eventSources(event)
    if (kind) kinds.set(kind.key, kind.sources)
  }

  const resolved = await Promise.all(
    [...kinds].map(
      async ([key, sources]) => [key, await readerEventClearance(reader, sources)] as const
    )
  )
  const byKind = new Map(resolved)

  return (event) => {
    const kind = eventSources(event)
    return kind ? byKind.get(kind.key) : clearance
  }
}

/**
 * Where an object event's values came from, when the current markings do not describe them all.
 *
 * - A projection's event holds the values of the version it applied.
 * - An update or a deletion also holds the values it replaced. An action's or a direct write's
 *   record of an object holds the values projections had applied then. Both came from versions
 *   applied before the event, which it does not name: they read like a version that cannot be read.
 * - Only an object created by an action or a direct write holds nothing but its own values.
 */
function eventSources(
  event: StoredDomainEvent
): { readonly key: string; readonly sources: EventSources } | undefined {
  if (event.topic !== "objects") return undefined

  const objectTypeId = event.payload.objectTypeId
  const earlier = event.type !== "object.created"

  if (event.origin?.kind !== "projection") {
    if (!earlier) return undefined
    return { key: JSON.stringify([objectTypeId]), sources: { objectTypeId, earlier } }
  }

  const { projectionId, datasetId, datasetVersionId } = event.origin
  const origin = { projectionId, datasetId, datasetVersionId, objectTypeId }
  return {
    key: JSON.stringify([objectTypeId, projectionId, datasetId, datasetVersionId, earlier]),
    sources: { objectTypeId, origin, earlier },
  }
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
    case "rules":
      return clearance.unreadableType(event.payload.subject.objectTypeId) !== undefined
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
