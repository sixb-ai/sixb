import type { OntologySource, Sixb } from "@sixb/core"
import type { Elysia } from "elysia"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import { ConnectorParamsSchema, ConnectorSchema } from "../schemas/connectors"

function serializeConnector(
  connector: ReturnType<Sixb<readonly OntologySource[]>["listConnectors"]>[number],
  sixb: Sixb<readonly OntologySource[]>
) {
  return {
    id: connector.id,
    type: connector.adapter.type,
    syncIds: sixb
      .getSyncDefinitions()
      .filter((sync) => sync.connector.id === connector.id)
      .map((sync) => sync.id),
    webhooks: sixb
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

export function registerConnectorRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/connectors",
      () => {
        return sixb.listConnectors().map((connector) => serializeConnector(connector, sixb))
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
      ({ params, set }) => {
        const connector = sixb.getConnectorById(params.connectorId)
        if (!connector) {
          set.status = 404
          return { error: "Connector not found" }
        }

        return serializeConnector(connector, sixb)
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
