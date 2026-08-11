import { assertPrivileged } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type { ConnectorRuntime, ConnectorsRuntime } from "./runtime"

export type ExecutionConnectorRuntime = ConnectorRuntime
export type ExecutionConnectorsRuntime = Pick<ConnectorsRuntime, "list" | "getById">

export function createExecutionConnectorsRuntime(
  runtime: SixbRuntimeContext,
  connector: ConnectorRuntime,
  connectors: ConnectorsRuntime
): {
  readonly connector: ExecutionConnectorRuntime
  readonly connectors: ExecutionConnectorsRuntime
} {
  return {
    connector: (definition) => {
      assertPrivileged(runtime, "connector.connect")
      return connector(definition)
    },
    connectors: {
      list: () => connectors.list(),
      getById: (connectorId) => connectors.getById(connectorId),
    },
  }
}
