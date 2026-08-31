import { AuthorizationError, assertProviderAccess } from "../authorization"
import type { ExecutionContext } from "../execution"
import { resolveExecutionScopeAuthorization } from "../execution/authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import { createConnectorCodedError } from "./errors"
import type { ConnectorService } from "./service"
import type {
  AnyConnectorAdapter,
  ConnectorAdapter,
  ConnectorClient,
  ConnectorConnectionMetadata,
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

export interface ConnectorExecutionSource<
  TAdapter extends AnyConnectorAdapter = AnyConnectorAdapter,
> {
  readonly connection?: ConnectorConnectionMetadata
  connect(signal: AbortSignal): Promise<ConnectorClient<TAdapter>>
}

export interface ConnectorExecutionSourceResolver {
  list<TAdapter extends AnyConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>
  ): Promise<readonly ConnectorExecutionSource<TAdapter>[]>
}

const sourceResolvers = new WeakMap<ConnectorRuntime, ConnectorExecutionSourceResolver>()

export function createConnectorRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  service: ConnectorService
): ConnectorRuntime {
  const connector = ((definition: ConnectorDefinition, selector?: ConnectorConnectionSelector) => {
    if (isOAuthConnectorDefinition(definition)) {
      assertConnectorConnectionAccess(runtime, execution)
      if (!selector) {
        throw createConnectorCodedError(
          "connector.configuration_invalid",
          `[Sixb] Connector '${definition.id}' uses persistent connections and requires an explicit owner and slot.`
        )
      }
      return service.connectConnection(definition, selector)
    }
    if (selector) {
      throw createConnectorCodedError(
        "connector.configuration_invalid",
        `[Sixb] Static connector '${definition.id}' does not accept a connection.`
      )
    }
    assertProviderAccess(runtime, execution, "connector.connect")
    return service.connect(definition as ConnectorDefinition<string, ConnectorAdapter>)
  }) as ConnectorRuntime

  registerConnectorExecutionSourceResolver(connector, {
    async list<TAdapter extends AnyConnectorAdapter>(
      definition: ConnectorDefinition<string, TAdapter>
    ): Promise<readonly ConnectorExecutionSource<TAdapter>[]> {
      if (!isOAuthConnectorDefinition(definition)) {
        return [
          {
            connect: (_signal) =>
              connector(definition as ConnectorDefinition<string, ConnectorAdapter>) as Promise<
                ConnectorClient<TAdapter>
              >,
          },
        ]
      }

      assertConnectorConnectionAccess(runtime, execution)
      const connections = await service.listExecutionConnections(definition)
      return connections.map((connection) => ({
        connection: {
          id: connection.id,
          connectorId: connection.connectorId,
          owner: connection.owner,
          slot: connection.slot,
          account: connection.account,
        },
        connect: (signal) =>
          service.connectExecutionConnection(definition, connection, signal) as Promise<
            ConnectorClient<TAdapter>
          >,
      }))
    },
  })
  return connector
}

function registerConnectorExecutionSourceResolver(
  connector: ConnectorRuntime,
  resolver: ConnectorExecutionSourceResolver
): void {
  const registered = sourceResolvers.get(connector)
  if (registered && registered !== resolver) {
    throw new Error("[Sixb] Connector source resolver is already registered for this execution.")
  }
  sourceResolvers.set(connector, resolver)
}

export function getConnectorExecutionSourceResolver(
  connector: ConnectorRuntime
): ConnectorExecutionSourceResolver {
  const resolver = sourceResolvers.get(connector)
  if (resolver) return resolver

  return {
    async list<TAdapter extends AnyConnectorAdapter>(
      definition: ConnectorDefinition<string, TAdapter>
    ): Promise<readonly ConnectorExecutionSource<TAdapter>[]> {
      if (isOAuthConnectorDefinition(definition)) {
        throw createConnectorCodedError(
          "connector.configuration_invalid",
          `[Sixb] OAuth connector '${definition.id}' cannot be resolved without the managed connection runtime.`
        )
      }
      return [
        {
          connect: (_signal) =>
            connector(definition as ConnectorDefinition<string, ConnectorAdapter>) as Promise<
              ConnectorClient<TAdapter>
            >,
        },
      ]
    },
  }
}

function assertConnectorConnectionAccess(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext
): void {
  const resolved = resolveExecutionScopeAuthorization(runtime.projectId, {
    execution,
    authorization: runtime.runtimeAuthorization,
  })
  if (resolved.type === "unrestricted" && resolved.ref.type === "trustedPrimitive") return
  throw new AuthorizationError(
    "privileged:connector-connection.connect",
    "[Sixb] Connector connection clients are restricted to trusted primitive executions."
  )
}
