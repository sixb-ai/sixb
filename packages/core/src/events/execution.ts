import { assertPrivileged, canViewEvent } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  EventsAppendInput,
  EventsEmitOptions,
  EventsReadInput,
  EventsSubscribeInput,
} from "./runtime"
import type { StoredDomainEvent } from "./types"

export interface ExecutionEventsRuntime {
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

export function createExecutionEventsRuntime(runtime: SixbRuntimeContext): ExecutionEventsRuntime {
  return {
    canRead: (event) => canViewEvent(runtime.authorization, event),
    append: (input) => {
      assertPrivileged(runtime, "events.append")
      return runtime.events.append(input)
    },
    emit: (input, options) => {
      assertPrivileged(runtime, "events.emit")
      return runtime.events.emit(input, options)
    },
    read: async (input) => {
      const events = await runtime.events.read(input)
      return events.filter((event) => canViewEvent(runtime.authorization, event))
    },
    latestCursor: () => runtime.events.latestCursor(),
    subscribe: (input, handler) =>
      runtime.events.subscribe(input, (events) => {
        const visible = events.filter((event) => canViewEvent(runtime.authorization, event))
        if (visible.length > 0) handler(visible)
      }),
  }
}
