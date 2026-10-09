import { assertPrivileged, canViewEvent } from "../authorization"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import { redactDomainEvent, resolvePropertyClearance } from "../objects/property-clearance"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  EventsAppendInput,
  EventsEmitOptions,
  EventsReadInput,
  EventsSubscribeInput,
} from "./service"
import type { StoredDomainEvent } from "./types"

export interface EventsRuntime {
  /** The event as this execution may read it: hidden events are `undefined`, others redacted. */
  readable(event: StoredDomainEvent): StoredDomainEvent | undefined
  append(input: EventsAppendInput): Promise<readonly StoredDomainEvent[]>
  emit(input: EventsAppendInput, options: EventsEmitOptions): Promise<void>
  read(input?: EventsReadInput): Promise<readonly StoredDomainEvent[]>
  latestCursor(): Promise<string | undefined>
  subscribe(
    input: EventsSubscribeInput,
    handler: (events: readonly StoredDomainEvent[]) => unknown
  ): Promise<() => void>
}

export function createEventsRuntime(runtime: SixbRuntimeContext): EventsRuntime {
  const authority = resolveRuntimeAuthorizationForProject(runtime)
  const clearance =
    authority.type === "principal"
      ? resolvePropertyClearance(runtime.ontology, authority.context.clearances ?? new Set())
      : undefined
  const readable = (event: StoredDomainEvent): StoredDomainEvent | undefined => {
    switch (authority.type) {
      case "denied":
      case "delegated":
        return undefined
      case "principal":
        if (!canViewEvent(authority.context, event)) return undefined
        return clearance ? redactDomainEvent(event, clearance) : event
      case "unrestricted":
        return event
    }
  }
  const visibleEvents = (events: readonly StoredDomainEvent[]): readonly StoredDomainEvent[] =>
    events.flatMap((event) => readable(event) ?? [])

  return {
    readable,
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
      const events = await runtime.events.read(input)
      return visibleEvents(events)
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
      return runtime.events.subscribe(input, (events) => {
        const visible = visibleEvents(events)
        if (visible.length > 0) return handler(visible)
      })
    },
  }
}
