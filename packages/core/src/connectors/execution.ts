import { assertProviderAccess } from "../authorization"
import type { ExecutionContext } from "../execution"
import type { SixbRuntimeContext } from "../runtime/types"
import type { ConnectorService } from "./service"
import type { ConnectorAdapter, ConnectorClient, ConnectorDefinition } from "./types"

/** Resolve a registered connector through one authorized execution. */
export type ConnectorRuntime = <TAdapter extends ConnectorAdapter>(
  definition: ConnectorDefinition<string, TAdapter>
) => Promise<ConnectorClient<TAdapter>>

export function createConnectorRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  service: ConnectorService
): ConnectorRuntime {
  return (definition) => {
    assertProviderAccess(runtime, execution, "connector.connect")
    return service.connect(definition)
  }
}
