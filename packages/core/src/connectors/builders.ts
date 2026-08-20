import { ConnectorError } from "./errors"
import type {
  AnyConnectorAdapter,
  ConnectorAdapter,
  ConnectorDefinition,
  ManagedConnectorAdapter,
} from "./types"

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
export function defineConnector<TId extends string, TAdapter extends ManagedConnectorAdapter>(
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

  if (
    "mode" in adapter &&
    adapter.mode !== undefined &&
    adapter.mode !== "static" &&
    adapter.mode !== "managed"
  ) {
    throw new ConnectorError("Connector adapter mode must be 'static' or 'managed'.")
  }

  if ("mode" in adapter && adapter.mode === "managed") {
    if (
      typeof adapter.authorizationUrl !== "function" ||
      typeof adapter.exchangeCode !== "function" ||
      typeof adapter.refresh !== "function" ||
      typeof adapter.discoverAccounts !== "function"
    ) {
      throw new ConnectorError(
        "Managed connector adapters must implement authorizationUrl, exchangeCode, refresh, and discoverAccounts."
      )
    }
    if ((adapter as { readonly webhooks?: unknown }).webhooks !== undefined) {
      throw new ConnectorError(
        "Managed connector adapters cannot register webhooks until connection routing is defined."
      )
    }
  }

  return {
    kind: "connector",
    id,
    adapter,
  }
}
