import { randomUUID } from "node:crypto"
import type {
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
  CompleteConnectorAuthorizationInput,
  CompleteConnectorAuthorizationResult,
  ConnectorConnectionCommandContext,
  ConnectorConnectionProcess,
  ConnectorConnectionView,
  RevokeConnectorAuthorizationResult,
  SelectConnectorAccountInput,
  StartConnectorAuthorizationInput,
  StartConnectorAuthorizationResult,
} from "./contracts"
import { connectorAuthorizationStatusError } from "./credential-mutations"
import { ConnectorAuthorizationRequestHandler } from "./request"
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

    this.authorizations = new DefaultConnectorAuthorizationLifecycle({
      projectId,
      storage: storage.connectorConnections,
      credentialProtector,
      resolveDefinition,
      hostSignal,
      accountSelectionTtlMs: options.accountSelectionTtlMs ?? DEFAULT_SELECTION_TTL_MS,
      credentialMutationLeaseMs:
        options.credentialMutationLeaseMs ?? DEFAULT_CREDENTIAL_MUTATION_LEASE_MS,
      providerOperationTimeoutMs:
        options.providerOperationTimeoutMs ?? DEFAULT_PROVIDER_OPERATION_TIMEOUT_MS,
      refreshSkewMs: options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS,
      now: options.now ?? (() => new Date()),
    })
    this.requests = new ConnectorAuthorizationRequestHandler({
      projectId,
      storage: storage.root,
      credentialProtector,
      authorizationAttemptTtlMs: options.authorizationAttemptTtlMs ?? DEFAULT_ATTEMPT_TTL_MS,
      providerOperationTimeoutMs:
        options.providerOperationTimeoutMs ?? DEFAULT_PROVIDER_OPERATION_TIMEOUT_MS,
      resolveDefinition,
      lifecycle: this.authorizations,
      hostSignal,
    })
  }

  async connectConnection<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    selector: ConnectorConnectionSelector
  ): Promise<ConnectorClient<TAdapter>> {
    this.assertOAuthRegistered(definition)
    assertConnectorConnectionSelector(selector)
    const connection = await this.connectionStorage.getConnection({
      projectId: this.projectId,
      connectorId: definition.id,
      ...selector,
    })
    if (!connection) {
      throw createConnectorCodedError(
        "connector.not_found",
        `Connector '${definition.id}' has no connection for project slot '${selector.slot}'.`
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
      const connection = await this.connectionStorage.getConnectionById({
        projectId: this.projectId,
        connectorId: definition.id,
        connectionId: normalizedConnectionId,
      })
      if (!connection) return null

      const authorization = await this.connectionStorage.getAuthorization({
        projectId: this.projectId,
        connectorId: definition.id,
        authorizationId: connection.authorizationId,
      })
      const disconnected = await this.connectionStorage.disconnectConnection({
        projectId: this.projectId,
        connectorId: definition.id,
        connectionId: normalizedConnectionId,
      })
      return disconnected
        ? connectorConnectionView(disconnected, authorization?.status ?? "needs_reauthorization")
        : null
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
