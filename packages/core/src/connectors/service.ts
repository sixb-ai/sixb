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
  OAuthConnectorAdapter,
} from "./types"
import { isOAuthConnectorDefinition } from "./types"

export type ConnectorServiceOptions = ConnectorConnectionServiceOptions

type StaticConnectorConnectionState = {
  readonly controller: AbortController
  readonly clientPromise: Promise<unknown>
}

/** Process-owned facade for static clients and persistent connector connections. */
export class ConnectorService {
  private readonly definitionsById: ReadonlyMap<string, ConnectorDefinition>
  private readonly staticConnectionStates = new Map<
    ConnectorDefinition<string, ConnectorAdapter>,
    StaticConnectorConnectionState
  >()
  private readonly connections?: ConnectorConnectionService

  constructor(
    private readonly projectId: string,
    definitions: readonly ConnectorDefinition[],
    options: ConnectorServiceOptions = {}
  ) {
    this.definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
    if (definitions.some(isOAuthConnectorDefinition)) {
      this.connections = new ConnectorConnectionService(projectId, definitions, options)
    }
  }

  async connect<TAdapter extends ConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>
  ): Promise<ConnectorClient<TAdapter>> {
    this.assertRegistered(definition)

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

  connectConnection<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    selector: ConnectorConnectionSelector
  ): Promise<ConnectorClient<TAdapter>> {
    return this.requireConnections().connectConnection(definition, selector)
  }

  get connectionProcess(): ConnectorConnectionProcess | undefined {
    return this.connections
  }

  async close(): Promise<void> {
    await this.connections?.close()
    const activeConnections = [...this.staticConnectionStates.entries()]
    this.staticConnectionStates.clear()
    for (const [definition, state] of activeConnections) {
      await this.disconnectStaticState(definition, state)
    }
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
