import { AuthorizationError, assertProviderAccess } from "../authorization"
import type { ExecutionContext } from "../execution"
import { resolveExecutionScopeAuthorization } from "../execution/authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import { createConnectorConnections } from "./connection-handles"
import { createConnectorCodedError } from "./errors"
import type { ConnectorService } from "./service"
import type {
  AnyConnectorAdapter,
  ConnectorAdapter,
  ConnectorClient,
  ConnectorConnectionMetadata,
  ConnectorConnectionSelector,
  ConnectorConnections,
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
  /**
   * The connections of an OAuth connector this run may use: a run someone requested gets the
   * project's and their own, and a run no one requested, such as one a schedule started, gets
   * every connected one whose owner isn't suspended.
   */
  connections<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>
  ): ConnectorConnections<ConnectorClient<TAdapter>>
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
      assertPersonalConnectionRequester(definition, execution, selector)
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

  const resolver: ConnectorExecutionSourceResolver = {
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
        // A grant that can no longer give a token fails here, before anything is read.
        connect: async (signal): Promise<ConnectorClient<TAdapter>> => {
          await service.assertExecutionConnectionUsable(definition, connection)
          return service.connectExecutionConnection(definition, connection, signal) as Promise<
            ConnectorClient<TAdapter>
          >
        },
      }))
    },
  }
  registerConnectorExecutionSourceResolver(connector, resolver)
  connector.connections = <TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>
  ) =>
    createConnectorConnections<ConnectorClient<TAdapter>>(resolver, definition, (connection) =>
      mayUsePersonalConnection(execution, connection)
    )
  return connector
}

/** The rule `assertPersonalConnectionRequester` enforces, as a filter. */
function mayUsePersonalConnection(
  execution: ExecutionContext,
  connection: ConnectorConnectionMetadata
): boolean {
  const owner = connection.owner
  const requester = execution.requestedBy
  if (owner.type !== "user" || requester === undefined) return true
  return requester.type === "user" && requester.id === owner.id
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

/**
 * A run someone requested opens only that person's own connection, so no one can act with another
 * person's account by calling an action, even with can.manage. A run no one requested, such as one
 * an event or a schedule started, picks the owner from its data, as syncs and webhooks do.
 */
function assertPersonalConnectionRequester(
  definition: ConnectorDefinition,
  execution: ExecutionContext,
  selector: ConnectorConnectionSelector
): void {
  const owner = selector.owner
  const requester = execution.requestedBy
  if (owner?.type !== "user" || requester === undefined) return
  if (requester.type === "user" && requester.id === owner.id) return
  throw new AuthorizationError(
    `connection:connector:${definition.id}`,
    `[Sixb] A run requested by someone else can't use a personal connection of connector '${definition.id}'. Only its owner's own runs, or runs no one requested, can.`
  )
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
