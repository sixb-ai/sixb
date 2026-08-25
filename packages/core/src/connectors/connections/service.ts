import { randomUUID } from "node:crypto"
import { isSixbError } from "../../errors/internal"
import type {
  ConnectorConnectionRecord,
  ConnectorConnectionStorage,
  PutConnectorConnectionResult,
  Storage,
} from "../../storage"
import {
  type ConnectorCredentialProtector,
  createEphemeralConnectorCredentialProtector,
} from "../credentials"
import {
  createConnectorCodedError,
  isConnectorStorageError,
  providerBoundaryError,
  providerFailureCode,
  storageBoundaryError,
} from "../errors"
import type {
  ConnectorClient,
  ConnectorConnectionSelector,
  ConnectorDefinition,
  OAuthConnectorAdapter,
} from "../types"
import { isOAuthConnectorDefinition } from "../types"
import {
  assertConnectorAuthorizationActor,
  DefaultConnectorAuthorizationLifecycle,
} from "./authorizations"
import { requireConnectorConnectionCommandActor } from "./command-context"
import type {
  AddConnectorConnectionInput,
  CompleteConnectorAuthorizationInput,
  CompleteConnectorAuthorizationResult,
  CompleteConnectorConnectionRunInput,
  CompleteConnectorConnectionRunResult,
  ConnectorConnectionCallbackProcess,
  ConnectorConnectionCommandContext,
  ConnectorConnectionProcess,
  ConnectorConnectionRunView,
  ConnectorConnectionView,
  RevokeConnectorAuthorizationResult,
  SelectConnectorAccountInput,
  SelectConnectorConnectionRunAccountInput,
  StartConnectorAuthorizationInput,
  StartConnectorAuthorizationResult,
  StartConnectorConnectionRunInput,
  StartConnectorConnectionRunResult,
} from "./contracts"
import { connectorAuthorizationStatusError } from "./credential-mutations"
import { ConnectorAuthorizationRequestHandler } from "./request"
import { ConnectorConnectionRunService } from "./runs"
import { withConnectorStorageBoundary } from "./storage-boundary"
import { nonblank } from "./validation"
import { assertConnectorConnectionSelector, connectorConnectionView } from "./views"

const DEFAULT_ATTEMPT_TTL_MS = 10 * 60_000
const DEFAULT_SELECTION_TTL_MS = 15 * 60_000
const DEFAULT_CREDENTIAL_MUTATION_LEASE_MS = 30_000
const DEFAULT_PROVIDER_OPERATION_TIMEOUT_MS = 2 * 60_000
const DEFAULT_REFRESH_SKEW_MS = 60_000

export interface ConnectorConnectionServiceOptions {
  readonly storage?: Storage
  readonly credentialProtector?: ConnectorCredentialProtector
  readonly authorizationAttemptTtlMs?: number
  readonly accountSelectionTtlMs?: number
  readonly credentialMutationLeaseMs?: number
  readonly providerOperationTimeoutMs?: number
  readonly connectionRunProcessingTtlMs?: number
  readonly refreshSkewMs?: number
  readonly now?: () => Date
}

/** Process-owned composition of connector connection lookup and OAuth lifecycle state. */
export class ConnectorConnectionService implements ConnectorConnectionProcess {
  private readonly definitionsById: ReadonlyMap<string, ConnectorDefinition>
  private abortController = new AbortController()
  private readonly connectionStorage: ConnectorConnectionStorage
  private readonly authorizations: DefaultConnectorAuthorizationLifecycle
  private readonly requests: ConnectorAuthorizationRequestHandler
  private readonly runs: ConnectorConnectionRunService
  readonly callbackProcess: ConnectorConnectionCallbackProcess

  constructor(
    private readonly projectId: string,
    definitions: readonly ConnectorDefinition[],
    options: ConnectorConnectionServiceOptions = {}
  ) {
    this.definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
    const storage = requireConnectionStorage(options.storage)
    this.connectionStorage = storage.connectorConnections
    const credentialProtector = credentialProtectorFor(storage.connectorConnections, options)
    const resolveDefinition = (connectorId: string) => this.requireOAuthDefinition(connectorId)
    const hostSignal = () => this.abortController.signal
    const now = options.now ?? (() => new Date())
    const accountSelectionTtlMs = options.accountSelectionTtlMs ?? DEFAULT_SELECTION_TTL_MS
    const providerOperationTimeoutMs =
      options.providerOperationTimeoutMs ?? DEFAULT_PROVIDER_OPERATION_TIMEOUT_MS

    this.authorizations = new DefaultConnectorAuthorizationLifecycle({
      projectId,
      storage: storage.connectorConnections,
      credentialProtector,
      resolveDefinition,
      hostSignal,
      accountSelectionTtlMs,
      credentialMutationLeaseMs:
        options.credentialMutationLeaseMs ?? DEFAULT_CREDENTIAL_MUTATION_LEASE_MS,
      providerOperationTimeoutMs,
      refreshSkewMs: options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS,
      now,
    })
    this.requests = new ConnectorAuthorizationRequestHandler({
      projectId,
      storage: storage.root,
      credentialProtector,
      authorizationAttemptTtlMs: options.authorizationAttemptTtlMs ?? DEFAULT_ATTEMPT_TTL_MS,
      providerOperationTimeoutMs,
      resolveDefinition,
      lifecycle: this.authorizations,
      hostSignal,
    })
    this.runs = new ConnectorConnectionRunService({
      projectId,
      storage: storage.root,
      requestHandler: this.requests,
      authorizations: this.authorizations,
      resolveDefinition,
      processingTtlMs:
        options.connectionRunProcessingTtlMs ?? providerOperationTimeoutMs * 2 + 30_000,
      selectionTtlMs: accountSelectionTtlMs,
      now,
    })
    this.callbackProcess = Object.freeze({
      completeConnectionRun: (input: CompleteConnectorConnectionRunInput) =>
        this.completeConnectionRun(input),
    })
  }

  async connectConnection<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    selector: ConnectorConnectionSelector
  ): Promise<ConnectorClient<TAdapter>> {
    this.assertOAuthRegistered(definition)
    assertConnectorConnectionSelector(selector)
    const connection = await withConnectorStorageBoundary(
      "Connector connection could not be read.",
      () =>
        this.connectionStorage.getConnection({
          projectId: this.projectId,
          connectorId: definition.id,
          ...selector,
        })
    )
    if (!connection) {
      throw createConnectorCodedError(
        "connector.not_found",
        `Connector '${definition.id}' has no connection for project slot '${selector.slot}'.`
      )
    }

    return this.connectExecutionConnection(definition, connection)
  }

  /** Snapshot the connected records that one trusted primitive execution may consume. */
  async listExecutionConnections<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>
  ): Promise<readonly ConnectorConnectionRecord[]> {
    this.assertOAuthRegistered(definition)
    const connections = await withConnectorStorageBoundary(
      "Connector connections could not be listed.",
      () =>
        this.connectionStorage.listConnections({
          projectId: this.projectId,
          connectorId: definition.id,
        })
    )
    return connections
      .filter((connection) => connection.status === "connected")
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  /** Resolve a client from an immutable connection snapshot captured for one execution. */
  async connectExecutionConnection<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    connection: ConnectorConnectionRecord
  ): Promise<ConnectorClient<TAdapter>> {
    this.assertOAuthRegistered(definition)
    if (
      connection.projectId !== this.projectId ||
      connection.connectorId !== definition.id ||
      connection.status !== "connected"
    ) {
      throw createConnectorCodedError(
        "connector.not_found",
        `Connector '${definition.id}' connection '${connection.id}' is not active in this project.`
      )
    }

    const authorization = await this.authorizations.requireStableActiveAuthorization(
      definition,
      connection.authorizationId
    )
    try {
      return (await definition.adapter.connect({
        projectId: this.projectId,
        connectorId: definition.id,
        connectionId: connection.id,
        account: connection.account,
        tokenSource: this.authorizations.createTokenSource(definition, authorization.id),
        signal: this.abortController.signal,
      })) as ConnectorClient<TAdapter>
    } catch (error) {
      throw providerBoundaryError(
        error,
        providerFailureCode(error),
        "Connector connection client creation failed."
      )
    }
  }

  async listConnections(
    command: ConnectorConnectionCommandContext,
    connectorId: string
  ): Promise<readonly ConnectorConnectionView[]> {
    const definition = this.requireOAuthDefinition(connectorId)
    requireConnectorConnectionCommandActor(command.execution, this.projectId)
    let connections: readonly ConnectorConnectionRecord[]
    try {
      connections = await this.connectionStorage.listConnections({
        projectId: this.projectId,
        connectorId: definition.id,
      })
    } catch (error) {
      throw storageBoundaryError(error, "Connector connections could not be listed.")
    }
    return withConnectorStorageBoundary("Connector authorizations could not be read.", () =>
      Promise.all(
        connections.map(async (connection) => {
          const authorization = await this.connectionStorage.getAuthorization({
            projectId: this.projectId,
            connectorId: definition.id,
            authorizationId: connection.authorizationId,
          })
          if (!authorization) {
            throw createConnectorCodedError(
              "internal.unexpected",
              "Connector connection references an unavailable authorization."
            )
          }
          return connectorConnectionView(connection, authorization.status)
        })
      )
    )
  }

  startConnectionRun(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    input: StartConnectorConnectionRunInput
  ): Promise<StartConnectorConnectionRunResult> {
    return this.runs.start(command, connectorId, input)
  }

  async addConnection(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    input: AddConnectorConnectionInput
  ): Promise<ConnectorConnectionRunView> {
    const definition = this.requireOAuthDefinition(connectorId)
    const actor = requireConnectorConnectionCommandActor(command.execution, this.projectId)
    assertConnectorConnectionSelector(input)
    const source = await withConnectorStorageBoundary(
      "Source connector connection could not be read.",
      () =>
        this.connectionStorage.getConnectionById({
          projectId: this.projectId,
          connectorId: definition.id,
          connectionId: nonblank(input.fromConnectionId, "source connection id"),
        })
    )
    if (!source) {
      throw createConnectorCodedError("connector.not_found", "Source connection was not found.")
    }
    if (source.status !== "connected") {
      throw createConnectorCodedError(
        "connector.authorization_required",
        "Source connection is disconnected."
      )
    }
    const authorization = await this.authorizations.requireStableActiveAuthorization(
      definition,
      source.authorizationId
    )
    assertConnectorAuthorizationActor(authorization, actor.principal)
    return this.runs.startSelection(command, definition.id, {
      owner: input.owner,
      slot: input.slot,
      authorizationId: authorization.id,
    })
  }

  getConnectionRun(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    runId: string
  ): Promise<ConnectorConnectionRunView | null> {
    this.requireOAuthDefinition(connectorId)
    return this.runs.get(command, connectorId, runId)
  }

  selectConnectionRunAccount(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    input: SelectConnectorConnectionRunAccountInput
  ): Promise<ConnectorConnectionRunView> {
    return this.runs.selectAccount(command, connectorId, input)
  }

  async startReauthorization(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    connectionId: string,
    input: Pick<StartConnectorConnectionRunInput, "redirectUri" | "returnTo">
  ): Promise<StartConnectorConnectionRunResult> {
    const definition = this.requireOAuthDefinition(connectorId)
    requireConnectorConnectionCommandActor(command.execution, this.projectId)
    const connection = await withConnectorStorageBoundary(
      "Connector connection could not be read.",
      () =>
        this.connectionStorage.getConnectionById({
          projectId: this.projectId,
          connectorId: definition.id,
          connectionId: nonblank(connectionId, "connection id"),
        })
    )
    if (!connection) {
      throw createConnectorCodedError("connector.not_found", "Connector connection was not found.")
    }
    if (connection.status !== "connected") {
      throw createConnectorCodedError(
        "connector.authorization_required",
        "Disconnected connector connections cannot be reauthorized; start a new connection."
      )
    }
    return this.runs.start(command, definition.id, {
      owner: connection.owner,
      slot: connection.slot,
      redirectUri: input.redirectUri,
      returnTo: input.returnTo,
      reauthorizationId: connection.authorizationId,
    })
  }

  async revokeConnection(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    connectionId: string
  ): Promise<RevokeConnectorAuthorizationResult> {
    const definition = this.requireOAuthDefinition(connectorId)
    requireConnectorConnectionCommandActor(command.execution, this.projectId)
    const authorization = await withConnectorStorageBoundary(
      "Connector authorization could not be resolved from its connection.",
      () =>
        this.connectionStorage.getAuthorizationByConnectionId({
          projectId: this.projectId,
          connectorId: definition.id,
          connectionId: nonblank(connectionId, "connection id"),
        })
    )
    if (!authorization) {
      throw createConnectorCodedError("connector.not_found", "Connector connection was not found.")
    }
    return this.revokeAuthorization(command, definition.id, authorization.id)
  }

  completeConnectionRun(
    input: CompleteConnectorConnectionRunInput
  ): Promise<CompleteConnectorConnectionRunResult> {
    return this.runs.complete(input)
  }

  startAuthorization(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    input: StartConnectorAuthorizationInput
  ): Promise<StartConnectorAuthorizationResult> {
    return this.requests.startAuthorization(command, connectorId, input)
  }

  completeAuthorization(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    input: CompleteConnectorAuthorizationInput
  ): Promise<CompleteConnectorAuthorizationResult> {
    return this.requests.completeAuthorization(command, connectorId, input)
  }

  async selectAccount(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    input: SelectConnectorAccountInput
  ): Promise<ConnectorConnectionView> {
    const definition = this.requireOAuthDefinition(connectorId)
    const actor = requireConnectorConnectionCommandActor(command.execution, this.projectId)
    assertConnectorConnectionSelector(input)
    const authorization = await this.authorizations.requireAuthorization(
      definition.id,
      input.authorizationId
    )
    if (authorization.status !== "pending_selection" && authorization.status !== "active") {
      throw connectorAuthorizationStatusError(authorization.status)
    }
    assertConnectorAuthorizationActor(authorization, actor.principal)
    const account = authorization.accounts.find((candidate) => candidate.id === input.accountId)
    if (!account) {
      throw createConnectorCodedError(
        "connector.not_found",
        `Account '${input.accountId}' is not exposed by this connector authorization.`
      )
    }

    let result: PutConnectorConnectionResult
    try {
      result = await this.connectionStorage.putConnection({
        id: `ccn_${randomUUID()}`,
        projectId: this.projectId,
        connectorId: definition.id,
        owner: input.owner,
        slot: input.slot,
        authorizationId: authorization.id,
        account,
        replace: input.replace === true,
      })
    } catch (error) {
      if (isConnectorStorageError(error, "authorization_conflict")) {
        await this.continueRevocationIfPending(definition, authorization.id)
        throw createConnectorCodedError(
          "connector.operation_conflict",
          "Connector authorization cannot be selected in its current state.",
          { cause: error }
        )
      }
      if (isConnectorStorageError(error, "connection_conflict")) {
        throw createConnectorCodedError(
          "connector.operation_conflict",
          "Connector slot is already occupied; explicit replacement is required.",
          { cause: error }
        )
      }
      throw storageBoundaryError(error, "Connector account selection could not be persisted.")
    }
    if (result.revocationPendingAuthorizationId) {
      await this.continuePendingRevocation(definition, result.revocationPendingAuthorizationId)
    }
    return connectorConnectionView(result.connection, result.authorization.status)
  }

  async disconnect(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    connectionId: string
  ): Promise<ConnectorConnectionView | null> {
    const definition = this.requireOAuthDefinition(connectorId)
    requireConnectorConnectionCommandActor(command.execution, this.projectId)
    const normalizedConnectionId = nonblank(connectionId, "connection id")
    try {
      const disconnected = await this.connectionStorage.disconnectConnection({
        projectId: this.projectId,
        connectorId: definition.id,
        connectionId: normalizedConnectionId,
      })
      if (!disconnected) return null
      if (disconnected.revocationPendingAuthorizationId) {
        await this.continuePendingRevocation(
          definition,
          disconnected.revocationPendingAuthorizationId
        )
      }
      return connectorConnectionView(disconnected.connection, disconnected.authorization.status)
    } catch (error) {
      if (isConnectorStorageError(error, "authorization_conflict")) {
        throw createConnectorCodedError(
          "connector.operation_conflict",
          "Connector connection cannot be disconnected while its authorization is changing.",
          { cause: error }
        )
      }
      throw storageBoundaryError(error, "Connector disconnection could not be persisted.")
    }
  }

  async revokeAuthorization(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    authorizationId: string
  ): Promise<RevokeConnectorAuthorizationResult> {
    const definition = this.requireOAuthDefinition(connectorId)
    const actor = requireConnectorConnectionCommandActor(command.execution, this.projectId)
    const revoked = await this.authorizations.revokeAuthorization({
      definition,
      authorizationId: nonblank(
        authorizationId,
        "authorization id",
        "connector.authorization_invalid"
      ),
      principal: actor.principal,
    })
    return {
      affectedConnections: revoked.disconnected.map((connection) =>
        connectorConnectionView(connection, "revoked")
      ),
    }
  }

  async close(): Promise<void> {
    this.runs.close()
    this.abortController.abort()
    this.abortController = new AbortController()
  }

  private assertOAuthRegistered(
    definition: ConnectorDefinition
  ): asserts definition is ConnectorDefinition<string, OAuthConnectorAdapter> {
    const registered = this.requireOAuthDefinition(definition.id)
    if (registered !== definition) {
      throw createConnectorCodedError(
        "connector.configuration_invalid",
        `Connector '${definition.id}' is not the registered definition instance.`
      )
    }
  }

  private requireOAuthDefinition(
    connectorId: string
  ): ConnectorDefinition<string, OAuthConnectorAdapter> {
    const definition = this.definitionsById.get(nonblank(connectorId, "connector id"))
    if (!definition) {
      throw createConnectorCodedError("connector.not_found", `Unknown connector '${connectorId}'.`)
    }
    if (!isOAuthConnectorDefinition(definition)) {
      throw createConnectorCodedError(
        "connector.configuration_invalid",
        `Connector '${connectorId}' does not use OAuth authentication.`
      )
    }
    return definition
  }

  private async continueRevocationIfPending(
    definition: ConnectorDefinition<string, OAuthConnectorAdapter>,
    authorizationId: string
  ): Promise<void> {
    const authorization = await this.authorizations.requireAuthorization(
      definition.id,
      authorizationId
    )
    if (authorization.status !== "revocation_pending") return
    await this.continuePendingRevocation(definition, authorization.id)
  }

  private async continuePendingRevocation(
    definition: ConnectorDefinition<string, OAuthConnectorAdapter>,
    authorizationId: string
  ): Promise<void> {
    try {
      await this.authorizations.continuePendingRevocation(definition, authorizationId)
    } catch (error) {
      if (isSixbError(error) && error.code === "connector.revocation_pending") return
      throw error
    }
  }
}

function requireConnectionStorage(storage: Storage | undefined): {
  readonly root: Storage
  readonly connectorConnections: ConnectorConnectionStorage
} {
  const connectorConnections = storage?.connectorConnections
  if (!storage || !connectorConnections) {
    throw createConnectorCodedError(
      "connector.configuration_invalid",
      "OAuth connectors require storage.connectorConnections to be configured."
    )
  }
  if (
    connectorConnections.durability !== "ephemeral" &&
    connectorConnections.durability !== "durable"
  ) {
    throw createConnectorCodedError(
      "connector.configuration_invalid",
      "Connector connection storage must declare 'ephemeral' or 'durable' durability."
    )
  }
  return { root: storage, connectorConnections }
}

function credentialProtectorFor(
  storage: ConnectorConnectionStorage,
  options: ConnectorConnectionServiceOptions
): ConnectorCredentialProtector {
  if (storage.durability === "durable" && !options.credentialProtector) {
    throw createConnectorCodedError(
      "connector.configuration_invalid",
      "Durable connector connection storage requires connectorConnections.encryptionKey to be configured."
    )
  }
  return options.credentialProtector ?? createEphemeralConnectorCredentialProtector()
}
