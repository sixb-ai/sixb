import type { ConnectorAuthorizationRecord, ConnectorConnectionRecord } from "../../storage"
import { createConnectorCodedError } from "../errors"
import type { ConnectorConnectionSelector } from "../types"
import type { ConnectorConnectionView } from "./contracts"
import { nonblank } from "./validation"

/** V1 accepts only project-owned slots; future owner kinds remain explicit extensions. */
export function assertConnectorConnectionSelector(selector: ConnectorConnectionSelector): void {
  if (selector.owner.type !== "project") {
    throw createConnectorCodedError(
      "connector.configuration_invalid",
      "Connector connections only support project ownership in V1."
    )
  }
  nonblank(selector.slot, "connection slot")
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
