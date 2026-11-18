import { isRuntimeAllowed } from "../authorization"
import type {
  ConnectorConnectionMetadata,
  ConnectorDefinition,
  OAuthConnectorAdapter,
} from "../connectors"
import type { ConnectorService } from "../connectors/service"
import type { ExecutionContext } from "../execution"
import type { SixbRuntimeContext } from "../runtime/types"

/**
 * The connections a sync of an OAuth connector runs for: every connected one whose owner isn't
 * suspended. Dispatch reads them without an execution, so a host registers them on itself.
 */
export interface SyncConnections {
  list(
    definition: ConnectorDefinition<string, OAuthConnectorAdapter>
  ): Promise<readonly ConnectorConnectionMetadata[]>
  /** Every connection of the connector, whatever its status: each one a run has read. */
  listAll(
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
  service: Pick<ConnectorService, "listExecutionConnections" | "listAllConnections">
): SyncConnections {
  return {
    async list(definition) {
      return (await service.listExecutionConnections(definition)).map(toMetadata)
    },
    async listAll(definition) {
      return (await service.listAllConnections(definition)).map(toMetadata)
    },
  }
}

function toMetadata({
  id,
  connectorId,
  owner,
  slot,
  account,
}: ConnectorConnectionMetadata): ConnectorConnectionMetadata {
  return { id, connectorId, owner, slot, account }
}

/**
 * Whether a caller who may run a sync may run, and see, its runs of this connection. Anyone may
 * run the project's. A person's own connection is theirs, and the connector's managers may act on
 * anyone's: a sync reads into rows its owner owns, as the schedule would. A run no one requested
 * may act on them all.
 */
export function mayRunConnection(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  connection: ConnectorConnectionMetadata
): boolean {
  return connection.owner.type === "project" || seesConnection(runtime, execution, connection)
}

/**
 * Whether the caller sees this connection itself, as the connector's connection views decide: the
 * owner of a personal connection, the connector's managers, and runs no one requested.
 */
export function seesConnection(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  connection: ConnectorConnectionMetadata
): boolean {
  const { owner } = connection
  const requester = execution.requestedBy
  if (requester === undefined) return true
  if (owner.type === "user" && requester.type === "user" && requester.id === owner.id) return true
  return isRuntimeAllowed(runtime, {
    kind: "connector.manage",
    connectorId: connection.connectorId,
  })
}
