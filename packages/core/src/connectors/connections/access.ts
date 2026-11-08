import { AuthorizationError } from "../../authorization"
import type { ConnectorConnectionRecord } from "../../storage"
import { createConnectorCodedError } from "../errors"
import {
  type ConnectorConnectionSelector,
  type ConnectorDefinition,
  connectorConnectionOwners,
} from "../types"
import type { ConnectorConnectionCommandActor } from "./command-context"
import type { ConnectorConnectionCommandContext } from "./contracts"

/*
 * Who may manage which connections:
 *
 *   project connection    callers with can.manage(connector)
 *   personal connection   its owner, a signed-in user, on a definition whose owners include "user"
 *
 * A manager also sees every personal connection and can disconnect it, but never acts as its
 * owner: reconnecting and revoking stay with whoever authorized the grant.
 */

/** Admits a command when the caller manages the connector, or may keep connections of their own. */
export function assertConnectorConnectionCommandAccess(
  definition: ConnectorDefinition,
  command: ConnectorConnectionCommandContext
): void {
  if (command.canManage || connectorConnectionOwners(definition).includes("user")) return
  throw manageRequired(definition)
}

/** Checks a selector the caller is about to fill. */
export function assertConnectorConnectionSelectorAccess(
  definition: ConnectorDefinition,
  command: ConnectorConnectionCommandContext,
  actor: ConnectorConnectionCommandActor,
  selector: ConnectorConnectionSelector
): void {
  if (!connectorConnectionOwners(definition).includes(selector.owner.type)) {
    throw createConnectorCodedError(
      "connector.configuration_invalid",
      selector.owner.type === "user"
        ? `[Sixb] Connector '${definition.id}' does not allow personal connections. Add owners: ["user"] to its definition.`
        : `[Sixb] Connector '${definition.id}' allows personal connections only.`
    )
  }
  if (selector.owner.type === "project") {
    if (!command.canManage) throw manageRequired(definition)
    return
  }
  if (actor.principal.type !== "user" || actor.principal.id !== selector.owner.id) {
    throw new AuthorizationError(
      `connection:connector:${definition.id}`,
      "[Sixb] A personal connection can only be made by its owner."
    )
  }
}

/** Whether the caller may see a connection: every one with can.manage, otherwise their own. */
export function canSeeConnectorConnection(
  command: ConnectorConnectionCommandContext,
  actor: ConnectorConnectionCommandActor,
  connection: ConnectorConnectionRecord
): boolean {
  return command.canManage || isOwnConnection(actor, connection)
}

function isOwnConnection(
  actor: ConnectorConnectionCommandActor,
  connection: ConnectorConnectionRecord
): boolean {
  return (
    connection.owner.type === "user" &&
    actor.principal.type === "user" &&
    connection.owner.id === actor.principal.id
  )
}

function manageRequired(definition: ConnectorDefinition): AuthorizationError {
  return new AuthorizationError(
    `manage:connector:${definition.id}`,
    `[Sixb] Managing connector '${definition.id}' connections requires can.manage(${definition.id}).`
  )
}
