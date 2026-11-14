import { createConnectorCodedError } from "./errors"
import type { ConnectorExecutionSourceResolver } from "./execution"
import {
  type ConnectorConnectionHandle,
  type ConnectorConnectionMetadata,
  type ConnectorConnections,
  type ConnectorDefinition,
  isOAuthConnectorDefinition,
} from "./types"

/**
 * Handles on the connections of one connector, read through the run's connection resolver. Each
 * call lists again, so a connection that went away since is not handed out. `mayUse` narrows the
 * list to what the run may act with.
 */
export function createConnectorConnections<TClient>(
  resolver: ConnectorExecutionSourceResolver,
  definition: ConnectorDefinition,
  mayUse: (connection: ConnectorConnectionMetadata) => boolean
): ConnectorConnections<TClient> {
  const handles = async (
    matches: (connection: ConnectorConnectionMetadata) => boolean
  ): Promise<readonly ConnectorConnectionHandle<TClient>[]> => {
    if (!isOAuthConnectorDefinition(definition)) {
      throw createConnectorCodedError(
        "connector.configuration_invalid",
        `Connector '${definition.id}' has no connections: it is not an OAuth connector.`
      )
    }
    const sources = await resolver.list(definition)
    return sources.flatMap(({ connection }) =>
      connection && mayUse(connection) && matches(connection) ? [handle(connection)] : []
    )
  }

  const handle = (connection: ConnectorConnectionMetadata): ConnectorConnectionHandle<TClient> => {
    let clientPromise: Promise<TClient> | undefined
    return {
      connection,
      client() {
        clientPromise ??= (async () => {
          const current = (await resolver.list(definition)).find(
            (candidate) =>
              candidate.connection?.id === connection.id &&
              candidate.connection.account.id === connection.account.id
          )
          if (!current)
            throw createConnectorCodedError(
              "connector.not_found",
              "The connection is no longer active for this account."
            )
          return (await current.connect(new AbortController().signal)) as TClient
        })()
        return clientPromise
      },
    }
  }

  return {
    list: () => handles(() => true),
    async forAccount(accountId) {
      if (typeof accountId !== "string" || !accountId.trim()) {
        throw createConnectorCodedError(
          "connector.configuration_invalid",
          "Account ID must be a non-empty string."
        )
      }
      return handles((connection) => connection.account.id === accountId)
    },
  }
}
