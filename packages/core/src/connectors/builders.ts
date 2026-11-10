import { ConnectorError, createConnectorCodedError } from "./errors"
import type {
  AnyConnectorAdapter,
  ConnectorAdapter,
  ConnectorConnectionOwner,
  ConnectorDefinition,
  ConnectorDefinitionOptions,
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
  adapter: TAdapter,
  options?: ConnectorDefinitionOptions
): ConnectorDefinition<TId, TAdapter>
export function defineConnector<TId extends string, TAdapter extends ConnectorAdapter>(
  id: TId,
  adapter: TAdapter
): ConnectorDefinition<TId, TAdapter>
export function defineConnector<TId extends string, TAdapter extends AnyConnectorAdapter>(
  id: TId,
  adapter: TAdapter,
  options: ConnectorDefinitionOptions = {}
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
      throw createConnectorCodedError(
        "connector.configuration_invalid",
        "OAuth connector adapters must define oauth2 authentication and implement authorizationUrl, exchangeCode, refresh, and discoverAccounts."
      )
    }
  }

  return {
    kind: "connector",
    id,
    adapter,
    ...(options.owners === undefined
      ? {}
      : { owners: connectorOwners(id, adapter, options.owners) }),
  }
}

function connectorOwners(
  id: string,
  adapter: AnyConnectorAdapter,
  owners: readonly unknown[]
): readonly ConnectorConnectionOwner["type"][] {
  if (!isOAuthConnectorAdapter(adapter)) {
    throw new ConnectorError(
      `Connector '${id}' has no OAuth connections to own; remove its owners option.`
    )
  }
  const valid = owners.filter(
    (owner): owner is ConnectorConnectionOwner["type"] => owner === "project" || owner === "user"
  )
  if (
    owners.length === 0 ||
    valid.length !== owners.length ||
    new Set(valid).size !== valid.length
  ) {
    throw new ConnectorError(
      `Connector '${id}' owners must list "project", "user" or both, each once.`
    )
  }
  return Object.freeze([...valid])
}
