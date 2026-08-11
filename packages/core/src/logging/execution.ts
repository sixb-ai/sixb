import { assertAuthorized } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type { LogsPage, LogsReadInput, LogsRuntime, LogsTailInput } from "./runtime"

export interface ExecutionLogsRuntime {
  assertObservable(): void
  read(input?: LogsReadInput): Promise<LogsPage>
  tail(input?: LogsTailInput): Promise<LogsPage>
}

export function createExecutionLogsRuntime(
  runtime: SixbRuntimeContext,
  source: LogsRuntime
): ExecutionLogsRuntime {
  const assertObservable = () => assertAuthorized(runtime, { kind: "logs.observe" })

  return {
    assertObservable,
    read: (input) => {
      assertObservable()
      return source.read(input)
    },
    tail: (input) => {
      assertObservable()
      return source.tail(input)
    },
  }
}
