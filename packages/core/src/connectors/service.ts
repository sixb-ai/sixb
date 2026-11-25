import type { SixbBranch } from "../branch-mode"
import { branchRefusals } from "../branch-mode/refusals"
import type { SandboxOAuthConnector } from "../sandboxes/auth"
import type { ConnectorConnectionRecord } from "../storage"
import type { ConnectorConnectionProcess } from "./connections/contracts"
import {
  ConnectorConnectionService,
  type ConnectorConnectionServiceOptions,
} from "./connections/service"
import { ConnectorError, ConnectorNotFoundError, createConnectorCodedError } from "./errors"
import type {
  ConnectorAdapter,
  ConnectorClient,
  ConnectorConnectionSelector,
  ConnectorDefinition,
  ConnectorTokenSource,
  OAuthConnectorAdapter,
} from "./types"
import { isOAuthConnectorDefinition } from "./types"

export interface ConnectorServiceOptions extends ConnectorConnectionServiceOptions {
  /** On a branch, every client and every connection change is refused: see `branch-mode/README.md`. */
  readonly branch?: SixbBranch | null
}

type StaticConnectorConnectionState = {
  readonly controller: AbortController
  readonly clientPromise: Promise<unknown>
}

/**
 * Process-owned facade for static clients and persistent connector connections.
 *
 * Every connector client is made here, whoever asks: an action's writeback or effects, a sync, a
 * workflow step, a webhook handler, an agent tool, a sandbox's token. That makes it the one place
 * a branch refuses them all.
 */
export class ConnectorService {
  private readonly definitionsById: ReadonlyMap<string, ConnectorDefinition>
  private readonly staticConnectionStates = new Map<
    ConnectorDefinition<string, ConnectorAdapter>,
    StaticConnectorConnectionState
  >()
  private readonly connections?: ConnectorConnectionService
  private readonly branch: SixbBranch | null
  private readonly lifecycle?: ConnectorConnectionProcess

  constructor(
    private readonly projectId: string,
    definitions: readonly ConnectorDefinition[],
    options: ConnectorServiceOptions = {}
  ) {
    this.definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
    this.branch = options.branch ?? null

    if (definitions.some(isOAuthConnectorDefinition)) {
      this.connections = new ConnectorConnectionService(projectId, definitions, options)
      this.lifecycle = this.branch
        ? refuseConnectionChanges(this.connections, this.branch)
        : this.connections
    }
  }

  async connect<TAdapter extends ConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>
  ): Promise<ConnectorClient<TAdapter>> {
    this.assertRegistered(definition)
    this.refuseOnBranch(definition)

    let state = this.staticConnectionStates.get(definition)
    if (!state) {
      const controller = new AbortController()
      const clientPromise = Promise.resolve(
        definition.adapter.connect({
          projectId: this.projectId,
          connectorId: definition.id,
          signal: controller.signal,
        })
      )
      state = { controller, clientPromise }
      this.staticConnectionStates.set(definition, state)
    }

    try {
      return (await state.clientPromise) as ConnectorClient<TAdapter>
    } catch (error) {
      if (this.staticConnectionStates.get(definition) === state) {
        this.staticConnectionStates.delete(definition)
      }
      throw error
    }
  }

  async connectConnection<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    selector: ConnectorConnectionSelector
  ): Promise<ConnectorClient<TAdapter>> {
    this.refuseOnBranch(definition)

    return this.requireConnections().connectConnection(definition, selector)
  }

  createConnectionTokenSource(
    connector: SandboxOAuthConnector,
    selector: ConnectorConnectionSelector
  ): ConnectorTokenSource {
    const definition = connector as unknown as ConnectorDefinition
    this.refuseOnBranch(definition)

    if (!isOAuthConnectorDefinition(definition)) {
      throw createConnectorCodedError(
        "connector.configuration_invalid",
        `[Sixb] Connector '${connector.id}' does not use persistent OAuth connections.`
      )
    }
    return this.requireConnections().createConnectionTokenSource(definition, selector)
  }

  listExecutionConnections<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>
  ): Promise<readonly ConnectorConnectionRecord[]> {
    return this.requireConnections().listExecutionConnections(definition)
  }

  /** Every connection of the connector, whatever its status: none is ever deleted. */
  listAllConnections<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>
  ): Promise<readonly ConnectorConnectionRecord[]> {
    return this.requireConnections().listAllConnections(definition)
  }

  /** Revokes every connection one person owns. Nothing to do without OAuth connectors. */
  async revokeUserConnections(userId: string): Promise<void> {
    await this.connections?.revokeUserConnections(userId)
  }

  /** Refreshes the grant's token when due, which reaches the provider: refused on a branch. */
  async assertExecutionConnectionUsable<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    connection: ConnectorConnectionRecord
  ): Promise<void> {
    this.refuseOnBranch(definition)

    return this.requireConnections().assertExecutionConnectionUsable(definition, connection)
  }

  async connectExecutionConnection<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    connection: ConnectorConnectionRecord,
    signal?: AbortSignal
  ): Promise<ConnectorClient<TAdapter>> {
    this.refuseOnBranch(definition)

    return this.requireConnections().connectExecutionConnection(definition, connection, signal)
  }

  /** The OAuth lifecycle the API serves. On a branch it lists, and refuses every change. */
  get connectionProcess(): ConnectorConnectionProcess | undefined {
    return this.lifecycle
  }

  async close(): Promise<void> {
    await this.connections?.close()
    const activeConnections = [...this.staticConnectionStates.entries()]
    this.staticConnectionStates.clear()
    for (const [definition, state] of activeConnections) {
      await this.disconnectStaticState(definition, state)
    }
  }

  private refuseOnBranch(definition: Pick<ConnectorDefinition, "id">): void {
    if (this.branch) throw branchRefusals.connector(this.branch, definition.id)
  }

  private assertRegistered(definition: ConnectorDefinition): void {
    const registeredDefinition = this.definitionsById.get(definition.id)
    if (!registeredDefinition) throw new ConnectorNotFoundError(definition.id)
    if (registeredDefinition !== definition) {
      throw new ConnectorError(
        `Connector '${definition.id}' is not the registered definition instance.`
      )
    }
  }

  private requireConnections(): ConnectorConnectionService {
    if (!this.connections) {
      throw createConnectorCodedError(
        "connector.configuration_invalid",
        "No OAuth connectors are registered with this runtime."
      )
    }
    return this.connections
  }

  private async disconnectStaticState(
    definition: ConnectorDefinition<string, ConnectorAdapter>,
    state: StaticConnectorConnectionState
  ): Promise<void> {
    state.controller.abort()
    let client: unknown
    try {
      client = await state.clientPromise
    } catch {
      return
    }
    if (typeof definition.adapter.disconnect === "function") {
      await definition.adapter.disconnect(client as never)
    }
  }
}

/**
 * The lifecycle with every change refused: connecting, choosing an account, reauthorizing,
 * disconnecting and revoking all reach the provider or production's connections. What lists and
 * reads stays, so the console shows the branch has none.
 */
function refuseConnectionChanges(
  process: ConnectorConnectionProcess,
  branch: SixbBranch
): ConnectorConnectionProcess {
  const refuse = async (connectorId?: string): Promise<never> => {
    throw branchRefusals.connection(branch, connectorId)
  }

  return {
    // An OAuth callback names its run by state alone.
    callbackProcess: { completeConnectionRun: () => refuse() },
    listConnections: (context, connectorId) => process.listConnections(context, connectorId),
    listPendingConnectionRuns: (context, connectorId) =>
      process.listPendingConnectionRuns(context, connectorId),
    getConnectionRun: (context, connectorId, runId) =>
      process.getConnectionRun(context, connectorId, runId),
    startConnectionRun: (_context, connectorId) => refuse(connectorId),
    addConnection: (_context, connectorId) => refuse(connectorId),
    selectConnectionRunAccount: (_context, connectorId) => refuse(connectorId),
    startReauthorization: (_context, connectorId) => refuse(connectorId),
    revokeConnection: (_context, connectorId) => refuse(connectorId),
    startAuthorization: (_context, connectorId) => refuse(connectorId),
    completeAuthorization: (_context, connectorId) => refuse(connectorId),
    selectAccount: (_context, connectorId) => refuse(connectorId),
    disconnect: (_context, connectorId) => refuse(connectorId),
    revokeAuthorization: (_context, connectorId) => refuse(connectorId),
  }
}
