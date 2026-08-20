import { ConnectorError, ConnectorNotFoundError } from "./errors"
import {
  type CompleteConnectorAuthorizationInput,
  type CompleteConnectorAuthorizationResult,
  type ConnectorConnectionView,
  type ConnectorManagementRuntime,
  ManagedConnectorService,
  type ManagedConnectorServiceOptions,
  type RevokeConnectorAuthorizationResult,
  type SelectConnectorAccountInput,
  type StartConnectorAuthorizationInput,
  type StartConnectorAuthorizationResult,
} from "./managed-service"
import type {
  ConnectorAdapter,
  ConnectorClient,
  ConnectorConnectionSelector,
  ConnectorDefinition,
  ManagedConnectorAdapter,
} from "./types"
import { isManagedConnectorDefinition } from "./types"

export type {
  CompleteConnectorAuthorizationInput,
  CompleteConnectorAuthorizationResult,
  ConnectorConnectionView,
  RevokeConnectorAuthorizationResult,
  SelectConnectorAccountInput,
  StartConnectorAuthorizationInput,
  StartConnectorAuthorizationResult,
} from "./managed-service"

export type ConnectorServiceOptions = ManagedConnectorServiceOptions

type StaticConnectorConnectionState = {
  readonly controller: AbortController
  readonly clientPromise: Promise<unknown>
}

/** Process-owned facade for static clients and the managed connector lifecycle. */
export class ConnectorService {
  private readonly definitionsById: ReadonlyMap<string, ConnectorDefinition>
  private readonly staticConnectionStates = new Map<
    ConnectorDefinition<string, ConnectorAdapter>,
    StaticConnectorConnectionState
  >()
  private readonly managed?: ManagedConnectorService

  constructor(
    private readonly projectId: string,
    definitions: readonly ConnectorDefinition[],
    options: ConnectorServiceOptions = {}
  ) {
    this.definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
    if (definitions.some(isManagedConnectorDefinition)) {
      this.managed = new ManagedConnectorService(projectId, definitions, options)
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

  connectManaged<TAdapter extends ManagedConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    selector: ConnectorConnectionSelector
  ): Promise<ConnectorClient<TAdapter>> {
    return this.requireManaged().connectManaged(definition, selector)
  }

  startAuthorization<TAdapter extends ManagedConnectorAdapter>(
    runtime: ConnectorManagementRuntime,
    definition: ConnectorDefinition<string, TAdapter>,
    input: StartConnectorAuthorizationInput
  ): Promise<StartConnectorAuthorizationResult> {
    return this.requireManaged().startAuthorization(runtime, definition, input)
  }

  completeAuthorization<TAdapter extends ManagedConnectorAdapter>(
    runtime: ConnectorManagementRuntime,
    definition: ConnectorDefinition<string, TAdapter>,
    input: CompleteConnectorAuthorizationInput
  ): Promise<CompleteConnectorAuthorizationResult> {
    return this.requireManaged().completeAuthorization(runtime, definition, input)
  }

  selectAccount<TAdapter extends ManagedConnectorAdapter>(
    runtime: ConnectorManagementRuntime,
    definition: ConnectorDefinition<string, TAdapter>,
    input: SelectConnectorAccountInput
  ): Promise<ConnectorConnectionView> {
    return this.requireManaged().selectAccount(runtime, definition, input)
  }

  disconnect<TAdapter extends ManagedConnectorAdapter>(
    runtime: ConnectorManagementRuntime,
    definition: ConnectorDefinition<string, TAdapter>,
    connectionId: string
  ): Promise<ConnectorConnectionView | null> {
    return this.requireManaged().disconnect(runtime, definition, connectionId)
  }

  revokeAuthorization<TAdapter extends ManagedConnectorAdapter>(
    runtime: ConnectorManagementRuntime,
    definition: ConnectorDefinition<string, TAdapter>,
    authorizationId: string
  ): Promise<RevokeConnectorAuthorizationResult> {
    return this.requireManaged().revokeAuthorization(runtime, definition, authorizationId)
  }

  async close(): Promise<void> {
    await this.managed?.close()
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

  private requireManaged(): ManagedConnectorService {
    if (!this.managed) {
      throw new ConnectorError("No managed connectors are registered with this runtime.")
    }
    return this.managed
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
