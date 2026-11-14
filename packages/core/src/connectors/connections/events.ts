import type { DomainEventService } from "../../events"
import type {
  ConnectorConnectionConnectedEvent,
  ConnectorConnectionDisconnectedEvent,
  EventDraft,
} from "../../events/types"
import type { ConnectorConnectionRecord } from "../../storage"
import type { ConnectorConnectionMetadata } from "../types"

/**
 * Announces connections becoming usable and unusable, after the write that changed them has
 * committed. Connection storage keeps no outbox, so an event the broker refuses is reported
 * through `onError` and lost: delivery is at most once, and code reacting to these events needs a
 * periodic pass to catch up.
 */
export class ConnectorConnectionEvents {
  constructor(private readonly events?: Pick<DomainEventService, "emit">) {}

  connected(
    connections: readonly ConnectorConnectionRecord[],
    reason: ConnectorConnectionConnectedEvent["payload"]["reason"]
  ): Promise<void> {
    return this.emit(
      connections.map((connection) => ({
        type: "connector.connection.connected",
        payload: { connectorId: connection.connectorId, connection: metadata(connection), reason },
      }))
    )
  }

  disconnected(
    connections: readonly ConnectorConnectionRecord[],
    reason: ConnectorConnectionDisconnectedEvent["payload"]["reason"]
  ): Promise<void> {
    return this.emit(
      connections.map((connection) => ({
        type: "connector.connection.disconnected",
        payload: { connectorId: connection.connectorId, connection: metadata(connection), reason },
      }))
    )
  }

  private async emit(events: readonly EventDraft[]): Promise<void> {
    if (!this.events || events.length === 0) return
    await this.events.emit({ events }, { source: "Sixb" })
  }
}

function metadata(connection: ConnectorConnectionRecord): ConnectorConnectionMetadata {
  return {
    id: connection.id,
    connectorId: connection.connectorId,
    owner: connection.owner,
    slot: connection.slot,
    account: connection.account,
  }
}
