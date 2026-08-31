import type { SixbHostView } from "@sixb/core"
import type {
  ConnectorConnectionRunView,
  ConnectorConnectionsRuntime,
  ConnectorConnectionView,
} from "@sixb/core/internal/connector-connections"
import {
  getConnectorConnectionsRuntime,
  isOAuthConnectorDefinition,
} from "@sixb/core/internal/connector-connections"
import { createSixbError } from "@sixb/core/internal/errors"
import type { z } from "zod"
import {
  CONNECTOR_HTTP_ERROR_CODES,
  type ConnectorConnectionRunSchema,
  type ConnectorConnectionSchema,
  type ConnectorHttpErrorCode,
} from "../schemas/connectors"
import { handleRouteError, toIsoString } from "../utils/http"

export function connectorRouteRuntime(
  host: SixbHostView,
  owner: object,
  connectorId: string
): ConnectorConnectionsRuntime {
  const definition = host.definitions.connectors.getById(connectorId)
  if (!definition) {
    throw createSixbError("connector.not_found", "[Sixb] Connector was not found.")
  }
  if (!isOAuthConnectorDefinition(definition)) {
    throw createSixbError(
      "connector.configuration_invalid",
      `[Sixb] Connector '${connectorId}' does not use OAuth authentication.`
    )
  }
  return getConnectorConnectionsRuntime(owner)
}

export function serializeConnectorConnection(
  connection: ConnectorConnectionView
): z.infer<typeof ConnectorConnectionSchema> {
  return {
    id: connection.id,
    connectorId: connection.connectorId,
    owner: connection.owner,
    slot: connection.slot,
    account: connection.account,
    status: connection.status,
  }
}

export function serializeConnectorConnectionRun(
  run: ConnectorConnectionRunView
): z.infer<typeof ConnectorConnectionRunSchema> {
  const base = {
    id: run.id,
    connectorId: run.connectorId,
    kind: run.kind,
    owner: run.owner,
    slot: run.slot,
    createdAt: toIsoString(run.createdAt),
    updatedAt: toIsoString(run.updatedAt),
  }
  if (run.status === "running") return { ...base, status: "running" }
  if (run.status === "waiting" && run.waitingFor === "provider_authorization") {
    return {
      ...base,
      status: "waiting",
      waitingFor: "provider_authorization",
      expiresAt: toIsoString(run.expiresAt),
    }
  }
  if (run.status === "waiting") {
    return {
      ...base,
      status: "waiting",
      waitingFor: "account_selection",
      accounts: [...run.accounts],
      expiresAt: toIsoString(run.expiresAt),
    }
  }
  if (run.status === "succeeded") {
    return {
      ...base,
      status: "succeeded",
      connections: run.connections.map(serializeConnectorConnection),
      finishedAt: toIsoString(run.finishedAt),
    }
  }
  if (run.status === "failed") {
    return {
      ...base,
      status: "failed",
      error: run.error,
      finishedAt: toIsoString(run.finishedAt),
    }
  }
  return { ...base, status: run.status, finishedAt: toIsoString(run.finishedAt) }
}

export function handleConnectorRouteError(
  error: unknown,
  set: { status?: number | string }
): { error: string } | { error: string; code: ConnectorHttpErrorCode } {
  const response = handleRouteError(error, set)
  if (response.code && (CONNECTOR_HTTP_ERROR_CODES as readonly string[]).includes(response.code)) {
    return { error: response.error, code: response.code as ConnectorHttpErrorCode }
  }
  return { error: response.error }
}
