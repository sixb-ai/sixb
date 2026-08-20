import { AuthorizationError, assertProviderAccess } from "../authorization"
import { assertRuntimeAuthorizationBound } from "../authorization/decision"
import type { ExecutionContext } from "../execution"
import type { SixbRuntimeContext } from "../runtime/types"
import type { ConnectorService } from "./service"
import type {
  ConnectorAdapter,
  ConnectorClient,
  ConnectorConnectionSelector,
  ConnectorDefinition,
  OAuthConnectorAdapter,
} from "./types"
import { isOAuthConnectorDefinition } from "./types"

/** Resolve a registered connector through one authorized execution. */
export interface ConnectorRuntime {
  <TAdapter extends ConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>
  ): Promise<ConnectorClient<TAdapter>>
  <TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    selector: ConnectorConnectionSelector
  ): Promise<ConnectorClient<TAdapter>>
}

export function createConnectorRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  service: ConnectorService
): ConnectorRuntime {
  return ((definition: ConnectorDefinition, selector?: ConnectorConnectionSelector) => {
    if (isOAuthConnectorDefinition(definition)) {
      assertConnectorConnectionAccess(runtime)
      if (!selector) {
        throw new Error(
          `[Sixb] Connector '${definition.id}' uses persistent connections and requires an explicit owner and slot.`
        )
      }
      return service.connectConnection(definition, selector)
    }
    if (selector) {
      throw new Error(`[Sixb] Static connector '${definition.id}' does not accept a connection.`)
    }
    assertProviderAccess(runtime, execution, "connector.connect")
    return service.connect(definition as ConnectorDefinition<string, ConnectorAdapter>)
  }) as ConnectorRuntime
}

function assertConnectorConnectionAccess(runtime: SixbRuntimeContext): void {
  const resolved = assertRuntimeAuthorizationBound(runtime)
  if (resolved.type === "unrestricted" && resolved.ref.type === "trustedPrimitive") return
  throw new AuthorizationError(
    "privileged:connector-connection.connect",
    "[Sixb] Connector connection clients are restricted to trusted primitive executions."
  )
}
