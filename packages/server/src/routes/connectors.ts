import type { OntologySource, SixbHostView } from "@sixb/core"
import { isOAuthConnectorDefinition } from "@sixb/core/internal/connector-connections"
import type { Sixb } from "@sixb/core/internal/request-execution"
import type { Elysia } from "elysia"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import { ConnectorParamsSchema, ConnectorSchema } from "../schemas/connectors"

function serializeConnector(
  connector: ReturnType<SixbHostView["definitions"]["connectors"]["list"]>[number],
  host: SixbHostView,
  execution: Sixb<readonly OntologySource[]>
) {
  return {
    id: connector.id,
    type: connector.adapter.type,
    connection: isOAuthConnectorDefinition(connector)
      ? { authentication: "oauth2" as const }
      : null,
    syncIds: execution.syncs
      .list()
      .filter((sync) => sync.connector.id === connector.id)
      .map((sync) => sync.id),
    webhooks: host
      .listWebhooks()
      .filter((registered) => registered.connector.id === connector.id)
      .map(({ webhook, route }) => ({
        id: webhook.id,
        method: webhook.method,
        route,
        bodyFormat: webhook.body.format,
        hasVerify: typeof webhook.verify === "function",
        hasIdempotency: typeof webhook.idempotencyKey === "function",
      })),
  }
}

export function registerConnectorRoutes(app: Elysia, host: SixbHostView) {
  return app
    .get(
      "/api/connectors",
      (context) => {
        const sixb = requireRequestSixb(context)
        return host.definitions.connectors
          .list()
          .map((connector) => serializeConnector(connector, host, sixb))
      },
      {
        response: { 200: ConnectorSchema.array() },
        detail: {
          summary: "List registered connectors",
          tags: [OPENAPI_TAGS.connectors.name],
          operationId: "listConnectors",
        },
      }
    )
    .get(
      "/api/connectors/:connectorId",
      (context) => {
        const { params, set } = context
        const sixb = requireRequestSixb(context)
        const connector = host.definitions.connectors.getById(params.connectorId)
        if (!connector) {
          set.status = 404
          return { error: "Connector not found" }
        }

        return serializeConnector(connector, host, sixb)
      },
      {
        params: ConnectorParamsSchema,
        response: { 200: ConnectorSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get connector metadata",
          tags: [OPENAPI_TAGS.connectors.name],
          operationId: "getConnector",
        },
      }
    )
}
