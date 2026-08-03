import { SixbError } from "../errors"
import type { ConnectorAdapter, ConnectorDefinition } from "./types"

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new SixbError("runtime.invalid_definition", `Connector ${field} must not be empty.`)
  }
}

/**
 * Define a connector instance for an external system.
 *
 * The returned definition is inert and can be exported from a project-level
 * `connectors/` module. Use `await sixb.connector(definition)` at runtime to
 * resolve it to a connected client.
 */
export function defineConnector<TId extends string, TAdapter extends ConnectorAdapter>(
  id: TId,
  adapter: TAdapter
): ConnectorDefinition<TId, TAdapter> {
  assertNonEmpty(id, "id")
  assertNonEmpty(adapter.type, "type")

  if (typeof adapter.connect !== "function") {
    throw new SixbError(
      "runtime.invalid_definition",
      "Connector adapter connect must be a function."
    )
  }

  return {
    kind: "connector",
    id,
    adapter,
  }
}
