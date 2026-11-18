import type {
  ConnectorConnectionMetadata,
  ConnectorDefinition,
  OAuthConnectorAdapter,
} from "../connectors"
import type { ConnectorService } from "../connectors/service"

/**
 * The connections a sync of an OAuth connector runs for: every connected one whose owner isn't
 * suspended. Dispatch reads them without an execution, so a host registers them on itself.
 */
export interface SyncConnections {
  list(
    definition: ConnectorDefinition<string, OAuthConnectorAdapter>
  ): Promise<readonly ConnectorConnectionMetadata[]>
}

const registered = new WeakMap<object, SyncConnections>()

export function registerSyncConnections(host: object, connections: SyncConnections): void {
  registered.set(host, connections)
}

export function findSyncConnections(host: object): SyncConnections | undefined {
  return registered.get(host)
}

export function createSyncConnections(
  service: Pick<ConnectorService, "listExecutionConnections">
): SyncConnections {
  return {
    async list(definition) {
      const connections = await service.listExecutionConnections(definition)
      return connections.map(({ id, connectorId, owner, slot, account }) => ({
        id,
        connectorId,
        owner,
        slot,
        account,
      }))
    },
  }
}
