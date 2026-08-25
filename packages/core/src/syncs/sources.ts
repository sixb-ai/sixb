import type { AnyConnectorAdapter, ConnectorDefinition, ConnectorRuntime } from "../connectors"
import {
  type ConnectorExecutionSource,
  type ConnectorExecutionSourceResolver,
  getConnectorExecutionSourceResolver,
} from "../connectors/execution"

/** One connector client invocation contributing values to a Sync run. */
export type SyncConnectorSource<TAdapter extends AnyConnectorAdapter = AnyConnectorAdapter> =
  ConnectorExecutionSource<TAdapter>

export type SyncConnectorSourceResolver = ConnectorExecutionSourceResolver

/** Resolve the source invocations owned by one connector definition for a Sync execution. */
export function resolveSyncConnectorSources<TAdapter extends AnyConnectorAdapter>(
  connector: ConnectorRuntime,
  definition: ConnectorDefinition<string, TAdapter>
): Promise<readonly SyncConnectorSource<TAdapter>[]> {
  return getConnectorExecutionSourceResolver(connector).list(definition)
}
