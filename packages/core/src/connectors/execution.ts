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
  ManagedConnectorAdapter,
} from "./types"
import { isManagedConnectorDefinition } from "./types"

/** Resolve a registered connector through one authorized execution. */
export interface ConnectorRuntime {
  <TAdapter extends ConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>
  ): Promise<ConnectorClient<TAdapter>>
  <TAdapter extends ManagedConnectorAdapter>(
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
    if (isManagedConnectorDefinition(definition)) {
      assertManagedConnectorAccess(runtime)
      if (!selector) {
        throw new Error(
          `[Sixb] Managed connector '${definition.id}' requires an explicit owner and slot.`
        )
      }
      return service.connectManaged(definition, selector)
    }
    if (selector) {
      throw new Error(`[Sixb] Static connector '${definition.id}' does not accept a connection.`)
    }
    assertProviderAccess(runtime, execution, "connector.connect")
    return service.connect(definition as ConnectorDefinition<string, ConnectorAdapter>)
  }) as ConnectorRuntime
}

function assertManagedConnectorAccess(runtime: SixbRuntimeContext): void {
  const resolved = assertRuntimeAuthorizationBound(runtime)
  if (resolved.type === "unrestricted" && resolved.ref.type === "trustedPrimitive") return
  throw new AuthorizationError(
    "privileged:managed-connector.connect",
    "[Sixb] Managed connector clients are restricted to trusted primitive executions."
  )
}
