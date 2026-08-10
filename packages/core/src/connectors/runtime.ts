import { ConnectorError, ConnectorNotFoundError } from "./errors"
import type { ConnectorAdapter, ConnectorClient, ConnectorDefinition } from "./types"

type ConnectorConnectionState = {
  controller: AbortController
  clientPromise: Promise<unknown>
}

/** Resolve an inert connector definition to its lazily connected client. */
export type ConnectorRuntime = <TAdapter extends ConnectorAdapter>(
  definition: ConnectorDefinition<string, TAdapter>
) => Promise<ConnectorClient<TAdapter>>

export interface ConnectorsRuntime {
  list(): readonly ConnectorDefinition[]
  getById(id: string): ConnectorDefinition | null
  disconnectAll(): Promise<void>
}

class ConnectorRegistry implements ConnectorsRuntime {
  private readonly definitionsById = new Map<string, ConnectorDefinition>()
  private readonly connectionStates = new Map<ConnectorDefinition, ConnectorConnectionState>()

  constructor(
    private readonly projectId: string,
    definitions: readonly ConnectorDefinition[]
  ) {
    for (const definition of definitions) {
      if (this.definitionsById.has(definition.id)) {
        throw new ConnectorError(`Duplicate connector id: ${definition.id}`)
      }

      this.definitionsById.set(definition.id, definition)
    }
  }

  list(): readonly ConnectorDefinition[] {
    return [...this.definitionsById.values()]
  }

  getById(id: string): ConnectorDefinition | null {
    return this.definitionsById.get(id) ?? null
  }

  async connect<TAdapter extends ConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>
  ): Promise<ConnectorClient<TAdapter>> {
    const registeredDefinition = this.definitionsById.get(definition.id)

    if (!registeredDefinition) {
      throw new ConnectorNotFoundError(definition.id)
    }

    if (registeredDefinition !== definition) {
      throw new ConnectorError(
        `Connector '${definition.id}' is not the registered definition instance.`
      )
    }

    let state = this.connectionStates.get(definition)
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
      this.connectionStates.set(definition, state)
    }

    try {
      return (await state.clientPromise) as ConnectorClient<TAdapter>
    } catch (error) {
      if (this.connectionStates.get(definition) === state) {
        this.connectionStates.delete(definition)
      }
      throw error
    }
  }

  async disconnectAll(): Promise<void> {
    const activeConnections = [...this.connectionStates.entries()]
    this.connectionStates.clear()

    for (const [definition, state] of activeConnections) {
      await this.disconnectState(definition, state)
    }
  }

  private async disconnectState(
    definition: ConnectorDefinition,
    state: ConnectorConnectionState
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

export function createConnectorsRuntime(
  projectId: string,
  definitions: readonly ConnectorDefinition[]
): { readonly connector: ConnectorRuntime; readonly connectors: ConnectorsRuntime } {
  const registry = new ConnectorRegistry(projectId, definitions)

  return {
    connector: (definition) => registry.connect(definition),
    connectors: registry,
  }
}
