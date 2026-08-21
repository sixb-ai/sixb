import { randomUUID } from "node:crypto"
import { principalKey } from "../../auth"
import { objectRefKey } from "../../materialization/refs"
import type {
  ConnectorAuthorizationRecord,
  ConnectorConnectionOwner,
  ConnectorConnectionRecord,
  ConnectorConnectionStatus,
} from "./types"

export function createConnectorAuthorizationAttemptId(): string {
  return `connattempt_${randomUUID().replaceAll("-", "")}`
}

export function createConnectorAuthorizationId(): string {
  return `connauth_${randomUUID().replaceAll("-", "")}`
}

export function createConnectorConnectionId(): string {
  return `conn_${randomUUID().replaceAll("-", "")}`
}

/**
 * Canonical string identity for a connection owner.
 *
 * Composed from the two derivations that already exist — `principalKey` and `objectRefKey` — rather
 * than a third spelling of the same thing. The JSON form `objectRefKey` produces owns its own
 * delimiters, so an id containing a colon cannot collide with a different owner.
 *
 * A SQL provider indexes this. Deriving it once in core is what lets Postgres and SQLite agree by
 * construction instead of by two hand-written dialect expressions that must be kept in step.
 */
export function connectorConnectionOwnerKey(owner: ConnectorConnectionOwner): string {
  switch (owner.type) {
    case "project":
      return "project"
    case "principal":
      return `principal:${principalKey(owner.principal)}`
    case "object":
      return `object:${objectRefKey(owner.ref)}`
  }
}

/**
 * Reads a connection's status from the connection and its grant.
 *
 * Deliberately derived rather than stored: a terminal refresh failure updates one authorization
 * row and every attached connection reports the new status on its next read, so there is no
 * fan-out to leave half-applied and no stored copy to fall out of step. A connection whose grant
 * was superseded without covering its account keeps its slot and reads as needing
 * reauthorization — it fails closed without any code having to remember to mark it.
 */
export function connectorConnectionStatus(
  connection: Pick<ConnectorConnectionRecord, "disconnectedAt">,
  authorization: Pick<ConnectorAuthorizationRecord, "status">
): ConnectorConnectionStatus {
  if (connection.disconnectedAt !== undefined) {
    return "disconnected"
  }
  switch (authorization.status) {
    case "active":
      return "connected"
    case "revoked":
      return "revoked"
    case "superseded":
    case "invalid":
      return "needs_reauthorization"
  }
}
