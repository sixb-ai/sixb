import type { ConnectorAuthorizationRecord, ConnectorConnectionRecord } from "../../storage"
import { createConnectorCodedError } from "../errors"
import type { ConnectorConnectionOwner, ConnectorConnectionSelector } from "../types"
import type { ConnectorConnectionView } from "./contracts"
import { nonblank } from "./validation"

/** Checks a selector's shape. Who may use it is decided in `access.ts`. */
export function assertConnectorConnectionSelector(selector: ConnectorConnectionSelector): void {
  if (!isConnectorConnectionOwner(selector.owner)) {
    throw createConnectorCodedError(
      "connector.configuration_invalid",
      'Connector connection owner must be { type: "project" } or { type: "user", id }.'
    )
  }
  nonblank(selector.slot, "connection slot")
}

function isConnectorConnectionOwner(value: unknown): value is ConnectorConnectionOwner {
  if (typeof value !== "object" || value === null) return false
  const { type, id } = value as Record<string, unknown>
  if (type === "project") return id === undefined
  return type === "user" && typeof id === "string" && id.trim() !== ""
}

export function connectorConnectionView(
  connection: ConnectorConnectionRecord,
  status: ConnectorAuthorizationRecord["status"]
): ConnectorConnectionView {
  return {
    id: connection.id,
    connectorId: connection.connectorId,
    owner: connection.owner,
    slot: connection.slot,
    account: connection.account,
    status:
      connection.status === "disconnected" ||
      status === "revoked" ||
      status === "revocation_pending"
        ? "disconnected"
        : status === "active"
          ? "connected"
          : "needs_reauthorization",
  }
}
