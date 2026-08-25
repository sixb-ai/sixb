import type { ConnectorConnectionsRuntime } from "./execution"

const connectorConnectionsRuntimeKey: unique symbol = Symbol("sixb.connectorConnectionsRuntime")

interface ConnectorConnectionsRuntimeOwner {
  readonly [connectorConnectionsRuntimeKey]?: ConnectorConnectionsRuntime
}

export function registerConnectorConnectionsRuntime(
  owner: object,
  runtime: ConnectorConnectionsRuntime
): void {
  const registered = (owner as ConnectorConnectionsRuntimeOwner)[connectorConnectionsRuntimeKey]
  if (registered && registered !== runtime) {
    throw new Error("[Sixb] Connector connections runtime is already registered for this owner.")
  }
  Object.defineProperty(owner, connectorConnectionsRuntimeKey, {
    configurable: false,
    enumerable: false,
    value: runtime,
    writable: false,
  })
}

export function getConnectorConnectionsRuntime(owner: object): ConnectorConnectionsRuntime {
  const runtime = (owner as ConnectorConnectionsRuntimeOwner)[connectorConnectionsRuntimeKey]
  if (runtime) return runtime
  throw new Error("[Sixb] Connector connections runtime is not registered for this execution.")
}
