import { canViewEvent } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type { EventsReadInput } from "./runtime"
import type { StoredDomainEvent } from "./types"

export interface ExecutionEventsRuntime {
  canRead(event: StoredDomainEvent): boolean
  read(input?: EventsReadInput): Promise<readonly StoredDomainEvent[]>
}

export function createExecutionEventsRuntime(runtime: SixbRuntimeContext): ExecutionEventsRuntime {
  return {
    canRead: (event) => canViewEvent(runtime.authorization, event),
    read: async (input) => {
      const events = await runtime.events.read(input)
      return events.filter((event) => canViewEvent(runtime.authorization, event))
    },
  }
}
