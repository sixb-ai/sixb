import { assertPrivileged, canViewEvent } from "../authorization"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  EventsAppendInput,
  EventsEmitOptions,
  EventsReadInput,
  EventsSubscribeInput,
} from "./service"
import type { StoredDomainEvent } from "./types"

export interface EventsRuntime {
  canRead(event: StoredDomainEvent): boolean
  append(input: EventsAppendInput): Promise<readonly StoredDomainEvent[]>
  emit(input: EventsAppendInput, options: EventsEmitOptions): Promise<void>
  read(input?: EventsReadInput): Promise<readonly StoredDomainEvent[]>
  latestCursor(): Promise<string | undefined>
  subscribe(
    input: EventsSubscribeInput,
    handler: (events: readonly StoredDomainEvent[]) => void
  ): Promise<() => void>
}

export function createEventsRuntime(runtime: SixbRuntimeContext): EventsRuntime {
  const authority = resolveRuntimeAuthorizationForProject(runtime)
  const visibleEvents = (events: readonly StoredDomainEvent[]): readonly StoredDomainEvent[] => {
    switch (authority.type) {
      case "denied":
      case "delegated":
        return []
      case "principal":
        return events.filter((event) => canViewEvent(authority.context, event))
      case "unrestricted":
        return [...events]
    }
  }

  return {
    canRead: (event) => {
      switch (authority.type) {
        case "denied":
        case "delegated":
          return false
        case "principal":
          return canViewEvent(authority.context, event)
        case "unrestricted":
          return true
      }
    },
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
        if (visible.length > 0) handler(visible)
      })
    },
  }
}
