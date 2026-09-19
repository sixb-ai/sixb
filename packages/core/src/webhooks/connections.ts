import { createConnectorCodedError } from "../connectors/errors"
import { type ConnectorRuntime, getConnectorExecutionSourceResolver } from "../connectors/execution"
import { type ConnectorDefinition, isOAuthConnectorDefinition } from "../connectors/types"
import type { WebhookConnections } from "./types"

/** Lookup stays inside the admitted execution's project and registered connector. */
export function createWebhookConnections(
  runtime: ConnectorRuntime,
  definition: ConnectorDefinition
): WebhookConnections {
  return {
    async forAccount(accountId) {
      if (!isOAuthConnectorDefinition(definition)) {
        throw createConnectorCodedError(
          "connector.configuration_invalid",
          "Webhook connections.forAccount() requires a managed OAuth connector."
        )
      }
      if (typeof accountId !== "string" || !accountId.trim()) {
        throw createConnectorCodedError(
          "connector.configuration_invalid",
          "Webhook account ID must be a non-empty string."
        )
      }
      const resolver = getConnectorExecutionSourceResolver(runtime)
      const sources = await resolver.list(definition)
      return sources.flatMap((source) => {
        const connection = source.connection
        if (!connection || connection.account.id !== accountId) return []
        const connectionId = connection.id
        let clientPromise: Promise<unknown> | undefined
        return [
          {
            connection,
            client() {
              clientPromise ??= (async () => {
                const current = (await resolver.list(definition)).find(
                  (candidate) =>
                    candidate.connection?.id === connectionId &&
                    candidate.connection.account.id === accountId
                )
                if (!current)
                  throw createConnectorCodedError(
                    "connector.not_found",
                    "Webhook connection is no longer active for this account."
                  )
                return current.connect(new AbortController().signal)
              })()
              return clientPromise
            },
          },
        ]
      })
    },
  }
}
