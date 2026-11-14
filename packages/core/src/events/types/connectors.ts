import type { ConnectorConnectionMetadata } from "../../connectors/types"
import type { EventEnvelope } from "../envelope"

/**
 * A connection became usable: someone selected an account for it, replaced the account in its
 * slot, or reconnected it after Sixb could no longer use it.
 */
export interface ConnectorConnectionConnectedEvent extends EventEnvelope {
  type: "connector.connection.connected"
  topic: "connectors"
  partitionKey: string
  payload: {
    connectorId: string
    connection: ConnectorConnectionMetadata
    reason: "connected" | "replaced" | "reconnected"
  }
}

/**
 * Sixb can no longer use a connection: it was disconnected, its grant was revoked, or the member
 * who owns it was suspended. A revoked connection's record stays; its grant does not.
 */
export interface ConnectorConnectionDisconnectedEvent extends EventEnvelope {
  type: "connector.connection.disconnected"
  topic: "connectors"
  partitionKey: string
  payload: {
    connectorId: string
    connection: ConnectorConnectionMetadata
    reason: "disconnected" | "revoked" | "suspended"
  }
}

export type ConnectorEvent =
  | ConnectorConnectionConnectedEvent
  | ConnectorConnectionDisconnectedEvent
