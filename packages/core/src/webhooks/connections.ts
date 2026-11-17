import { createConnectorConnections } from "../connectors/connection-handles"
import { type ConnectorRuntime, getConnectorExecutionSourceResolver } from "../connectors/execution"
import type { ConnectorConnections, ConnectorDefinition } from "../connectors/types"

/** A webhook run is one no one requested, so it may use every connection of its connector. */
export function createWebhookConnections(
  runtime: ConnectorRuntime,
  definition: ConnectorDefinition
): ConnectorConnections {
  return createConnectorConnections(
    getConnectorExecutionSourceResolver(runtime),
    definition,
    () => true
  )
}
