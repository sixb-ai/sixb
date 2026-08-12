import { ConnectorError, ConnectorNotFoundError } from "./errors"
import type { ConnectorAdapter, ConnectorClient, ConnectorDefinition } from "./types"

type ConnectorConnectionState = {
  controller: AbortController
  clientPromise: Promise<unknown>
}

/** Process-owned connector clients and their lifecycle. */
export class ConnectorService {
  private readonly definitionsById: ReadonlyMap<string, ConnectorDefinition>
  private readonly connectionStates = new Map<ConnectorDefinition, ConnectorConnectionState>()

  constructor(
    private readonly projectId: string,
    definitions: readonly ConnectorDefinition[]
  ) {
    this.definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
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

  async close(): Promise<void> {
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
