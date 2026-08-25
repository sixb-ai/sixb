import type { SixbHostView } from "@sixb/core"
import type { Elysia } from "elysia"
import { requireRequestSixb } from "../auth/scope"
import {
  connectorRouteRuntime,
  handleConnectorRouteError,
  serializeConnectorConnection,
} from "../connectors/http"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema, SuccessResponseSchema } from "../schemas/common"
import {
  ConnectorBadGatewayResponseSchema,
  ConnectorBadRequestResponseSchema,
  ConnectorConflictResponseSchema,
  ConnectorConnectionParamsSchema,
  ConnectorConnectionSchema,
  ConnectorInternalErrorResponseSchema,
  ConnectorNotFoundResponseSchema,
  ConnectorParamsSchema,
  ConnectorUnavailableResponseSchema,
  StartConnectorConnectionRunResponseSchema,
} from "../schemas/connectors"

export function registerConnectorConnectionRoutes(app: Elysia, host: SixbHostView) {
  return app
    .get(
      "/api/connectors/:connectorId/connections",
      async (context) => {
        const { params, set } = context
        try {
          const runtime = connectorRouteRuntime(
            host,
            requireRequestSixb(context),
            params.connectorId
          )
          const connections = await runtime.listConnections(params.connectorId)
          return connections.map(serializeConnectorConnection)
        } catch (error) {
          return handleConnectorRouteError(error, set)
        }
      },
      {
        params: ConnectorParamsSchema,
        response: {
          200: ConnectorConnectionSchema.array(),
          400: ConnectorBadRequestResponseSchema,
          403: ErrorResponseSchema,
          404: ConnectorNotFoundResponseSchema,
          500: ConnectorInternalErrorResponseSchema,
        },
        detail: {
          summary: "List connector connections",
          tags: [OPENAPI_TAGS.connectorConnections.name],
          operationId: "listConnectorConnections",
        },
      }
    )
    .delete(
      "/api/connectors/:connectorId/connections/:connectionId",
      async (context) => {
        const { params, set } = context
        try {
          const runtime = connectorRouteRuntime(
            host,
            requireRequestSixb(context),
            params.connectorId
          )
          const disconnected = await runtime.disconnect(params.connectorId, params.connectionId)
          if (!disconnected) {
            set.status = 404
            return { error: "Connector connection not found" }
          }
          return { success: true }
        } catch (error) {
          return handleConnectorRouteError(error, set)
        }
      },
      {
        params: ConnectorConnectionParamsSchema,
        response: {
          200: SuccessResponseSchema,
          400: ConnectorBadRequestResponseSchema,
          403: ErrorResponseSchema,
          404: ConnectorNotFoundResponseSchema,
          409: ConnectorConflictResponseSchema,
          500: ConnectorInternalErrorResponseSchema,
        },
        detail: {
          summary: "Disconnect a connector account",
          tags: [OPENAPI_TAGS.connectorConnections.name],
          operationId: "disconnectConnectorConnection",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/connectors/:connectorId/connections/:connectionId/revoke",
      async (context) => {
        const { params, set } = context
        try {
          const runtime = connectorRouteRuntime(
            host,
            requireRequestSixb(context),
            params.connectorId
          )
          const result = await runtime.revokeConnection(params.connectorId, params.connectionId)
          return {
            affectedConnections: result.affectedConnections.map(serializeConnectorConnection),
          }
        } catch (error) {
          return handleConnectorRouteError(error, set)
        }
      },
      {
        params: ConnectorConnectionParamsSchema,
        response: {
          200: StartConnectorConnectionRunResponseSchema.pick({ affectedConnections: true }),
          400: ConnectorBadRequestResponseSchema,
          403: ErrorResponseSchema,
          404: ConnectorNotFoundResponseSchema,
          409: ConnectorConflictResponseSchema,
          500: ConnectorInternalErrorResponseSchema,
          502: ConnectorBadGatewayResponseSchema,
          503: ConnectorUnavailableResponseSchema,
        },
        detail: {
          summary: "Revoke a connector authorization",
          tags: [OPENAPI_TAGS.connectorConnections.name],
          operationId: "revokeConnectorConnection",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
}
