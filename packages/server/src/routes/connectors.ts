import type { OntologySource, Pario } from "@pario/core"
import type { Elysia } from "elysia"
import { ErrorResponseSchema } from "../schemas/common"
import { ConnectorParamsSchema, ConnectorSchema } from "../schemas/connectors"

function serializeConnector(
  connector: ReturnType<Pario<readonly OntologySource[]>["listConnectors"]>[number],
  pario: Pario<readonly OntologySource[]>
) {
  return {
    id: connector.id,
    type: connector.adapter.type,
    syncIds: pario
      .getSyncDefinitions()
      .filter((sync) => sync.connector.id === connector.id)
      .map((sync) => sync.id),
    webhooks: pario
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

export function registerConnectorRoutes(app: Elysia, pario: Pario<readonly OntologySource[]>) {
  return app
    .get(
      "/api/connectors",
      () => {
        return pario.listConnectors().map((connector) => serializeConnector(connector, pario))
      },
      {
        response: { 200: ConnectorSchema.array() },
        detail: {
          summary: "List registered connectors",
          tags: ["Connectors"],
          operationId: "listConnectors",
        },
      }
    )
    .get(
      "/api/connectors/:connectorId",
      ({ params, set }) => {
        const connector = pario.getConnectorById(params.connectorId)
        if (!connector) {
          set.status = 404
          return { error: "Connector not found" }
        }

        return serializeConnector(connector, pario)
      },
      {
        params: ConnectorParamsSchema,
        response: { 200: ConnectorSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get connector metadata",
          tags: ["Connectors"],
          operationId: "getConnector",
        },
      }
    )
}
