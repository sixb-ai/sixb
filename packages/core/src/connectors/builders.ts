import { ConnectorError } from "./errors"
import type {
  AnyConnectorAdapter,
  ConnectorAdapter,
  ConnectorDefinition,
  OAuthConnectorAdapter,
} from "./types"
import { isOAuthConnectorAdapter } from "./types"

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new ConnectorError(`Connector ${field} must not be empty.`)
  }
}

/**
 * Define a connector instance for an external system.
 *
 * The returned definition is inert and can be exported from a project-level
 * `connectors/` module. Use `await sixb.connector(definition)` at runtime to
 * resolve it to a connected client.
 */
export function defineConnector<TId extends string, TAdapter extends OAuthConnectorAdapter>(
  id: TId,
  adapter: TAdapter
): ConnectorDefinition<TId, TAdapter>
export function defineConnector<TId extends string, TAdapter extends ConnectorAdapter>(
  id: TId,
  adapter: TAdapter
): ConnectorDefinition<TId, TAdapter>
export function defineConnector<TId extends string, TAdapter extends AnyConnectorAdapter>(
  id: TId,
  adapter: TAdapter
): ConnectorDefinition<TId, TAdapter> {
  assertNonEmpty(id, "id")
  assertNonEmpty(adapter.type, "type")

  if (typeof adapter.connect !== "function") {
    throw new ConnectorError("Connector adapter connect must be a function.")
  }

  if (adapter.authentication !== undefined) {
    if (
      !isOAuthConnectorAdapter(adapter) ||
      typeof adapter.authentication.authorizationUrl !== "function" ||
      typeof adapter.authentication.exchangeCode !== "function" ||
      typeof adapter.authentication.refresh !== "function" ||
      typeof adapter.discoverAccounts !== "function"
    ) {
      throw new ConnectorError(
        "OAuth connector adapters must define oauth2 authentication and implement authorizationUrl, exchangeCode, refresh, and discoverAccounts."
      )
    }
    if (adapter.webhooks !== undefined) {
      throw new ConnectorError(
        "OAuth connector adapters cannot register webhooks until connection routing is defined."
      )
    }
  }

  return {
    kind: "connector",
    id,
    adapter,
  }
}
