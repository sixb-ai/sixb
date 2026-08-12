import { assertAuthorized } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type { LoggingService, LogsPage, LogsReadInput, LogsTailInput } from "./service"

export interface LogsRuntime {
  assertObservable(): void
  read(input?: LogsReadInput): Promise<LogsPage>
  tail(input?: LogsTailInput): Promise<LogsPage>
}

export function createLogsRuntime(
  runtime: SixbRuntimeContext,
  source: LoggingService
): LogsRuntime {
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
