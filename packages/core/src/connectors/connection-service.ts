import { createHash, randomBytes, randomUUID } from "node:crypto"
import {
  type AuthorizationContext,
  AuthorizationError,
  assertCanManageConnector,
} from "../authorization"
import { assertRuntimeAuthorizationBound } from "../authorization/decision"
import type { AuthorizablePrincipal, RuntimeAuthorization } from "../execution"
import type {
  ClaimConnectorCredentialMutationResult,
  ConnectorAuthorizationAttemptRecord,
  ConnectorAuthorizationRecord,
  ConnectorConnectionRecord,
  ConnectorConnectionStorage,
  ConnectorCredentialMutationKind,
  PutConnectorConnectionResult,
} from "../storage"
import {
  assertAuthorizationUrlParameters,
  delay,
  hashSecret,
  nonblank,
  nonNegativeDuration,
  normalizedHttpUrl,
  parseAttemptId,
  parseCredentials,
  positiveDuration,
  sameIds,
  serializeCredentials,
  shouldRefresh,
  tokenView,
  validateAccounts,
  validateCredentials,
} from "./connection-validation"
import {
  type ConnectorCredentialProtector,
  createEphemeralConnectorCredentialProtector,
} from "./credentials"
import {
  createAmbiguousProviderOperationError,
  createConnectorCodedError,
  isConnectorStorageError,
  oauthErrorKind,
  providerBoundaryError,
  providerFailureCode,
  recoverConnectorFailure,
  storageBoundaryError,
} from "./errors"
import type {
  ConnectorAccountCandidate,
  ConnectorClient,
  ConnectorConnectionSelector,
  ConnectorDefinition,
  ConnectorOAuthCredentials,
  OAuthConnectorAdapter,
} from "./types"
import { isOAuthConnectorDefinition } from "./types"

const DEFAULT_ATTEMPT_TTL_MS = 10 * 60_000
const DEFAULT_SELECTION_TTL_MS = 15 * 60_000
const DEFAULT_CREDENTIAL_MUTATION_LEASE_MS = 30_000
const DEFAULT_CREDENTIAL_MUTATION_TIMEOUT_MS = 2 * 60_000
const DEFAULT_REFRESH_SKEW_MS = 60_000
const MUTATION_POLL_MS = 25
const MUTATION_WAIT_MS = 5_000
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export interface ConnectorManagementRuntime {
  readonly runtimeAuthorization?: RuntimeAuthorization
  readonly authorization?: AuthorizationContext
}

export interface ConnectorConnectionServiceOptions {
  readonly storage?: ConnectorConnectionStorage
  readonly credentialProtector?: ConnectorCredentialProtector
  readonly authorizationAttemptTtlMs?: number
  readonly accountSelectionTtlMs?: number
  readonly credentialMutationLeaseMs?: number
  readonly credentialMutationTimeoutMs?: number
  readonly refreshSkewMs?: number
  readonly now?: () => Date
}

export interface StartConnectorAuthorizationInput extends ConnectorConnectionSelector {
  readonly redirectUri: string
  readonly reauthorizationId?: string
}

export interface StartConnectorAuthorizationResult {
  readonly authorizationUrl: string
  readonly affectedConnections: readonly ConnectorConnectionView[]
}

export interface CompleteConnectorAuthorizationInput {
  readonly state: string
  readonly code: string
  readonly redirectUri: string
}

/** Internal selection result. Slice 2 maps this to a secret-free HTTP representation. */
export interface CompleteConnectorAuthorizationResult extends ConnectorConnectionSelector {
  readonly authorizationId: string
  readonly accounts: readonly ConnectorAccountCandidate[]
}

export interface SelectConnectorAccountInput extends ConnectorConnectionSelector {
  readonly authorizationId: string
  readonly accountId: string
  readonly replace?: boolean
}

export interface ConnectorConnectionView extends ConnectorConnectionSelector {
  readonly id: string
  readonly connectorId: string
  readonly account: ConnectorAccountCandidate
  readonly status: ConnectorAuthorizationRecord["status"]
}

export interface RevokeConnectorAuthorizationResult {
  readonly affectedConnections: readonly ConnectorConnectionView[]
}

type CredentialMutationClaimOutcome =
  | {
      readonly type: "claimed"
      readonly claim: ClaimConnectorCredentialMutationResult
    }
  | {
      readonly type: "superseded"
      readonly authorization: ConnectorAuthorizationRecord
    }

/** Framework-owned OAuth lifecycle for connector connection definitions. */
export class ConnectorConnectionService {
  private readonly definitionsById: ReadonlyMap<string, ConnectorDefinition>
  private abortController = new AbortController()
  private readonly connectionStorage: ConnectorConnectionStorage
  private readonly credentialProtector: ConnectorCredentialProtector
  private readonly authorizationAttemptTtlMs: number
  private readonly accountSelectionTtlMs: number
  private readonly credentialMutationLeaseMs: number
  private readonly credentialMutationTimeoutMs: number
  private readonly refreshSkewMs: number
  private readonly now: () => Date
  private readonly mutationHolderId = `connector-service-${randomUUID()}`
  private readonly localMutationTails = new Map<string, Promise<void>>()

  constructor(
    private readonly projectId: string,
    definitions: readonly ConnectorDefinition[],
    options: ConnectorConnectionServiceOptions = {}
  ) {
    this.definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
    this.authorizationAttemptTtlMs = positiveDuration(
      options.authorizationAttemptTtlMs ?? DEFAULT_ATTEMPT_TTL_MS,
      "authorization attempt TTL"
    )
    this.accountSelectionTtlMs = positiveDuration(
      options.accountSelectionTtlMs ?? DEFAULT_SELECTION_TTL_MS,
      "account selection TTL"
    )
    this.credentialMutationLeaseMs = positiveDuration(
      options.credentialMutationLeaseMs ?? DEFAULT_CREDENTIAL_MUTATION_LEASE_MS,
      "credential mutation lease duration"
    )
    this.credentialMutationTimeoutMs = positiveDuration(
      options.credentialMutationTimeoutMs ?? DEFAULT_CREDENTIAL_MUTATION_TIMEOUT_MS,
      "credential mutation timeout"
    )
    this.refreshSkewMs = nonNegativeDuration(
      options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS,
      "refresh skew"
    )
    this.now = options.now ?? (() => new Date())

    if (!options.storage) {
      throw createConnectorCodedError(
        "connector.configuration_invalid",
        "OAuth connectors require storage.connectorConnections to be configured."
      )
    }
    if (options.storage.durability !== "ephemeral" && options.storage.durability !== "durable") {
      throw createConnectorCodedError(
        "connector.configuration_invalid",
        "Connector connection storage must declare 'ephemeral' or 'durable' durability."
      )
    }
    if (options.storage.durability === "durable" && !options.credentialProtector) {
      throw createConnectorCodedError(
        "connector.configuration_invalid",
        "Durable connector connection storage requires connectorConnections.encryptionKey to be configured."
      )
    }
    this.connectionStorage = options.storage
    this.credentialProtector =
      options.credentialProtector ?? createEphemeralConnectorCredentialProtector()
  }

  async connectConnection<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    selector: ConnectorConnectionSelector
  ): Promise<ConnectorClient<TAdapter>> {
    this.assertOAuthRegistered(definition)
    assertSelector(selector)
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
    const authorization = await this.requireStableActiveAuthorization(
      definition,
      connection.authorizationId
    )
    const tokenSource = new ConnectorConnectionTokenSource(this, definition, authorization.id)
    try {
      return (await definition.adapter.connect({
        projectId: this.projectId,
        connectorId: definition.id,
        connectionId: connection.id,
        account: connection.account,
        tokenSource,
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

  async startAuthorization<TAdapter extends OAuthConnectorAdapter>(
    runtime: ConnectorManagementRuntime,
    definition: ConnectorDefinition<string, TAdapter>,
    input: StartConnectorAuthorizationInput
  ): Promise<StartConnectorAuthorizationResult> {
    this.assertOAuthRegistered(definition)
    const actor = this.managementActor(runtime, definition.id)
    assertSelector(input)
    const redirectUri = normalizedHttpUrl(input.redirectUri, "OAuth callback URL")
    let affectedConnections: readonly ConnectorConnectionView[] = []
    let reauthorizationConnectionIds: readonly string[] | undefined
    if (input.reauthorizationId !== undefined) {
      const authorization = await this.requireAuthorization(
        definition.id,
        nonblank(input.reauthorizationId, "reauthorization id")
      )
      if (authorization.status === "revoked" || authorization.status === "revocation_pending") {
        throw createConnectorCodedError(
          "connector.authorization_invalid",
          "Revoked connector credentials cannot be reauthorized."
        )
      }
      assertAuthorizationActor(authorization, actor.principal)
      const connections = await this.connectionStorage.listConnectionsByAuthorization(
        authorization.id
      )
      reauthorizationConnectionIds = connections.map((connection) => connection.id).sort()
      affectedConnections = connections.map((connection) =>
        connectionView(connection, authorization.status)
      )
    }

    const attemptId = `cat_${randomUUID()}`
    const state = `${attemptId}.${randomBytes(32).toString("base64url")}`
    const codeVerifier = randomBytes(32).toString("base64url")
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
    const context = this.authorizationAdapterContext(definition.id, redirectUri)
    let authorizationUrlInput: string | URL
    try {
      authorizationUrlInput = await definition.adapter.authentication.authorizationUrl(context, {
        state,
        codeChallenge,
        codeChallengeMethod: "S256",
      })
    } catch (error) {
      throw providerBoundaryError(
        error,
        providerFailureCode(error),
        "Connector authorization could not be started."
      )
    }
    const authorizationUrl = normalizedHttpUrl(
      authorizationUrlInput,
      "provider authorization URL",
      "connector.adapter_invalid"
    )
    assertAuthorizationUrlParameters(authorizationUrl, { state, codeChallenge })
    const sealedVerifier = await this.credentialProtector.seal(textEncoder.encode(codeVerifier), {
      projectId: this.projectId,
      connectorId: definition.id,
      recordId: attemptId,
      purpose: "pkce-verifier",
    })
    try {
      await this.connectionStorage.createAuthorizationAttempt({
        id: attemptId,
        projectId: this.projectId,
        connectorId: definition.id,
        owner: input.owner,
        slot: input.slot,
        redirectUri,
        ...(input.reauthorizationId === undefined
          ? {}
          : {
              reauthorizationId: input.reauthorizationId,
              reauthorizationConnectionIds,
            }),
        authorizedBy: actor.principal,
        credential: actor.credential,
        stateHash: hashSecret(state),
        codeVerifier: sealedVerifier,
        ttlMs: this.authorizationAttemptTtlMs,
      })
    } catch (error) {
      throw storageBoundaryError(error, "Connector authorization attempt could not be persisted.")
    }
    return { authorizationUrl, affectedConnections }
  }

  async completeAuthorization<TAdapter extends OAuthConnectorAdapter>(
    runtime: ConnectorManagementRuntime,
    definition: ConnectorDefinition<string, TAdapter>,
    input: CompleteConnectorAuthorizationInput
  ): Promise<CompleteConnectorAuthorizationResult> {
    this.assertOAuthRegistered(definition)
    const actor = this.managementActor(runtime, definition.id)
    const state = nonblank(input.state, "OAuth state", "connector.authorization_invalid")
    const code = nonblank(input.code, "OAuth authorization code", "connector.authorization_invalid")
    const redirectUri = normalizedHttpUrl(input.redirectUri, "OAuth callback URL")
    let attempt: ConnectorAuthorizationAttemptRecord
    try {
      attempt = await this.connectionStorage.consumeAuthorizationAttempt({
        id: parseAttemptId(state),
        projectId: this.projectId,
        connectorId: definition.id,
        authorizedBy: actor.principal,
        credential: actor.credential,
        stateHash: hashSecret(state),
        redirectUri,
      })
    } catch (error) {
      if (isConnectorStorageError(error, "attempt_invalid")) {
        throw createConnectorCodedError(
          "connector.authorization_invalid",
          "Connector authorization attempt is invalid, expired, or already used.",
          { cause: error }
        )
      }
      throw storageBoundaryError(error, "Connector authorization attempt could not be consumed.")
    }
    const verifierBytes = await this.credentialProtector.open(attempt.codeVerifier, {
      projectId: this.projectId,
      connectorId: definition.id,
      recordId: attempt.id,
      purpose: "pkce-verifier",
    })
    const codeVerifier = textDecoder.decode(verifierBytes)

    const completed =
      attempt.reauthorizationId === undefined
        ? await this.completeNewAuthorization(
            definition,
            actor.principal,
            code,
            codeVerifier,
            redirectUri
          )
        : await this.runLocallySerialized(attempt.reauthorizationId, () =>
            this.completeReauthorization(
              definition,
              attempt.reauthorizationId!,
              attempt.reauthorizationConnectionIds ?? [],
              actor.principal,
              code,
              codeVerifier,
              redirectUri
            )
          )

    return {
      authorizationId: completed.id,
      owner: attempt.owner,
      slot: attempt.slot,
      accounts: completed.accounts,
    }
  }

  async selectAccount<TAdapter extends OAuthConnectorAdapter>(
    runtime: ConnectorManagementRuntime,
    definition: ConnectorDefinition<string, TAdapter>,
    input: SelectConnectorAccountInput
  ): Promise<ConnectorConnectionView> {
    this.assertOAuthRegistered(definition)
    const actor = this.managementActor(runtime, definition.id)
    assertSelector(input)
    const authorization = await this.requireAuthorization(definition.id, input.authorizationId)
    if (authorization.status !== "pending_selection" && authorization.status !== "active") {
      throw authorizationStatusError(authorization.status)
    }
    assertAuthorizationActor(authorization, actor.principal)
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
    return connectionView(result.connection, result.authorization.status)
  }

  async disconnect<TAdapter extends OAuthConnectorAdapter>(
    runtime: ConnectorManagementRuntime,
    definition: ConnectorDefinition<string, TAdapter>,
    connectionId: string
  ): Promise<ConnectorConnectionView | null> {
    this.assertOAuthRegistered(definition)
    this.managementActor(runtime, definition.id)
    const connection = await this.connectionStorage.getConnectionById(
      nonblank(connectionId, "connection id")
    )
    if (
      !connection ||
      connection.projectId !== this.projectId ||
      connection.connectorId !== definition.id
    ) {
      return null
    }
    const authorization = await this.connectionStorage.getAuthorization(connection.authorizationId)
    const disconnected = await this.connectionStorage.disconnectConnection({
      projectId: this.projectId,
      connectorId: definition.id,
      connectionId,
    })
    return disconnected
      ? connectionView(disconnected, authorization?.status ?? "needs_reauthorization")
      : null
  }

  async revokeAuthorization<TAdapter extends OAuthConnectorAdapter>(
    runtime: ConnectorManagementRuntime,
    definition: ConnectorDefinition<string, TAdapter>,
    authorizationId: string
  ): Promise<RevokeConnectorAuthorizationResult> {
    this.assertOAuthRegistered(definition)
    const actor = this.managementActor(runtime, definition.id)
    const id = nonblank(authorizationId, "authorization id", "connector.authorization_invalid")
    return this.runLocallySerialized(id, async () => {
      let authorization = await this.requireAuthorization(definition.id, id)
      assertAuthorizationActor(authorization, actor.principal)
      if (authorization.status === "revoked") return { affectedConnections: [] }
      authorization = await this.prepareAuthorizationForMutation(
        definition,
        authorization,
        "revocation"
      )
      if (authorization.status === "revoked") return { affectedConnections: [] }

      const claimOutcome = await this.claimCredentialMutation(
        definition,
        authorization,
        "revocation"
      )
      if (claimOutcome.type === "superseded") return { affectedConnections: [] }
      const { claim } = claimOutcome
      const fence = mutationFence(claim.authorization)
      let credentials: ConnectorOAuthCredentials | undefined
      if (definition.adapter.authentication.revoke) {
        try {
          credentials = await this.openCredentials(definition.id, claim.authorization)
        } catch (error) {
          await recoverConnectorFailure(
            error,
            "Connector credential mutation could not be released after credential decryption failed.",
            () => this.releaseCredentialMutation(claim.authorization)
          )
          throw createConnectorCodedError(
            "connector.credentials_unavailable",
            "Connector revocation is pending, but stored credentials could not be opened.",
            { cause: error }
          )
        }
      }

      try {
        await this.executeCredentialMutation(claim.authorization, async (executing, signal) => {
          if (definition.adapter.authentication.revoke && credentials) {
            await definition.adapter.authentication.revoke(
              this.adapterContext(definition.id, signal),
              credentials
            )
          }
          assertOperationActive(signal)
          const staged = await this.connectionStorage.stageCredentialMutationRevocation({
            ...mutationFence(executing),
            holderId: this.mutationHolderId,
          })
          if (!staged) throw createAmbiguousProviderOperationError()
          return staged
        })
      } catch (error) {
        const latest = await recoverConnectorFailure(
          error,
          "Connector revocation outcome could not be recovered from storage.",
          () => this.requireAuthorization(definition.id, id)
        )
        if (isStagedMutation(latest, fence.mutationId, "revocation")) {
          await recoverConnectorFailure(
            error,
            "Staged connector revocation could not be finalized during recovery.",
            () => this.finalizeStagedMutation(definition, latest)
          )
          return {
            affectedConnections: claim.disconnected.map((connection) =>
              connectionView(connection, "revoked")
            ),
          }
        }
        await recoverConnectorFailure(
          error,
          "Connector revocation mutation could not be released for retry.",
          () => this.releaseCredentialMutation(claim.authorization)
        )
        throw createConnectorCodedError(
          "connector.revocation_pending",
          "Connector revocation is pending; provider revocation can be retried safely.",
          { cause: error }
        )
      }

      const staged = await this.requireAuthorization(definition.id, id)
      await this.finalizeStagedMutation(definition, staged)
      return {
        affectedConnections: claim.disconnected.map((connection) =>
          connectionView(connection, "revoked")
        ),
      }
    })
  }

  async close(): Promise<void> {
    this.abortController.abort()
    this.abortController = new AbortController()
  }

  async getAccessToken<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    authorizationId: string,
    rejectedRevision?: number
  ): Promise<{
    readonly token: { readonly accessToken: string; readonly tokenType?: string }
    readonly revision: number
  }> {
    let authorization = await this.requireStableActiveAuthorization(definition, authorizationId)
    const credentials = await this.openCredentials(definition.id, authorization)
    const refreshRejectedToken =
      rejectedRevision !== undefined && rejectedRevision === authorization.revision
    if (refreshRejectedToken || shouldRefresh(authorization, this.now(), this.refreshSkewMs)) {
      authorization = await this.refreshAuthorization(definition, authorization)
      const refreshed = await this.openCredentials(definition.id, authorization)
      return { token: tokenView(refreshed), revision: authorization.revision }
    }
    return { token: tokenView(credentials), revision: authorization.revision }
  }

  private async completeNewAuthorization<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    principal: AuthorizablePrincipal,
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<ConnectorAuthorizationRecord> {
    const authorizationId = `cau_${randomUUID()}`
    const credentials = await this.exchangeAuthorizationCode(
      definition,
      code,
      codeVerifier,
      redirectUri
    )
    const credentialsEnvelope = await this.sealCredentials(
      definition.id,
      authorizationId,
      credentials
    )
    let pending: ConnectorAuthorizationRecord
    try {
      pending = await this.connectionStorage.createAuthorization({
        id: authorizationId,
        projectId: this.projectId,
        connectorId: definition.id,
        authorizedBy: principal,
        credentials: credentialsEnvelope,
        ...(credentials.expiresAt === undefined
          ? {}
          : { credentialExpiresAt: credentials.expiresAt }),
        scopes: credentials.scopes ?? [],
        accounts: [],
        selectionTtlMs: this.accountSelectionTtlMs,
      })
    } catch (error) {
      throw storageBoundaryError(error, "Connector authorization could not be persisted.")
    }

    let accounts: readonly ConnectorAccountCandidate[]
    try {
      accounts = validateAccounts(
        await definition.adapter.discoverAccounts(this.adapterContext(definition.id), credentials)
      )
    } catch (error) {
      throw providerBoundaryError(
        error,
        "connector.provider_failed",
        "Connector account discovery failed; the pending authorization will expire without selection."
      )
    }
    const initialized = await this.connectionStorage.initializeAuthorizationAccounts({
      projectId: this.projectId,
      connectorId: definition.id,
      authorizationId,
      expectedRevision: pending.revision,
      accounts,
    })
    if (!initialized) {
      throw createConnectorCodedError(
        "connector.operation_conflict",
        "Connector authorization changed while accounts were discovered."
      )
    }
    return initialized
  }

  private async completeReauthorization<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    authorizationId: string,
    expectedConnectionIds: readonly string[],
    principal: AuthorizationContext["principal"],
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<ConnectorAuthorizationRecord> {
    let authorization = await this.requireAuthorization(definition.id, authorizationId)
    if (authorization.status === "revoked" || authorization.status === "revocation_pending") {
      throw createConnectorCodedError(
        "connector.authorization_invalid",
        "Revoked connector credentials cannot be reauthorized."
      )
    }
    assertAuthorizationActor(authorization, principal)
    await this.assertAttachedConnections(authorization.id, expectedConnectionIds)
    authorization = await this.prepareAuthorizationForMutation(
      definition,
      authorization,
      "reauthorization"
    )
    await this.assertAttachedConnections(authorization.id, expectedConnectionIds)
    const claimOutcome = await this.claimCredentialMutation(
      definition,
      authorization,
      "reauthorization",
      expectedConnectionIds
    )
    if (claimOutcome.type === "superseded") {
      throw createConnectorCodedError(
        "internal.unexpected",
        "Connector reauthorization was superseded unexpectedly."
      )
    }
    const { claim } = claimOutcome

    try {
      await this.executeCredentialMutation(claim.authorization, async (executing, signal) => {
        const credentials = validateCredentials(
          await definition.adapter.authentication.exchangeCode(
            this.authorizationAdapterContext(definition.id, redirectUri, signal),
            { code, codeVerifier }
          )
        )
        assertOperationActive(signal)
        const envelope = await this.sealCredentials(definition.id, authorizationId, credentials)
        assertOperationActive(signal)
        const staged = await this.connectionStorage.stageCredentialMutationCredentials({
          ...mutationFence(executing),
          holderId: this.mutationHolderId,
          credentials: envelope,
          ...(credentials.expiresAt === undefined
            ? {}
            : { credentialExpiresAt: credentials.expiresAt }),
          scopes: credentials.scopes ?? [],
        })
        if (!staged) throw createAmbiguousProviderOperationError()
        return staged
      })
    } catch (error) {
      const latest = await recoverConnectorFailure(
        error,
        "Connector reauthorization outcome could not be recovered from storage.",
        () => this.requireAuthorization(definition.id, authorizationId)
      )
      if (isStagedMutation(latest, claim.authorization.credentialMutation!.id, "reauthorization")) {
        return recoverConnectorFailure(
          error,
          "Staged connector reauthorization could not be finalized during recovery.",
          () => this.finalizeStagedMutation(definition, latest)
        )
      }
      if (oauthErrorKind(error) === "retryable" || oauthErrorKind(error) === "terminal") {
        await recoverConnectorFailure(
          error,
          "Connector reauthorization mutation could not be released after provider failure.",
          () => this.releaseCredentialMutation(claim.authorization)
        )
        throw createConnectorCodedError(
          "connector.provider_failed",
          "Connector authorization code exchange failed; restart authorization.",
          { cause: error }
        )
      }
      await recoverConnectorFailure(
        error,
        "Connector authorization could not be failed closed after an ambiguous code exchange.",
        () => this.markNeedsReauthorization(claim.authorization)
      )
      throw createConnectorCodedError(
        "connector.authorization_required",
        "Connector authorization code exchange had an ambiguous outcome; reauthorization is required.",
        { cause: error }
      )
    }

    const staged = await this.requireAuthorization(definition.id, authorizationId)
    return this.finalizeStagedMutation(definition, staged)
  }

  private async exchangeAuthorizationCode<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<ConnectorOAuthCredentials> {
    try {
      return validateCredentials(
        await this.withBoundedProviderSignal((signal) =>
          definition.adapter.authentication.exchangeCode(
            this.authorizationAdapterContext(definition.id, redirectUri, signal),
            { code, codeVerifier }
          )
        )
      )
    } catch (error) {
      throw providerBoundaryError(
        error,
        "connector.provider_failed",
        "Connector authorization code exchange failed."
      )
    }
  }

  private async refreshAuthorization<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    initial: ConnectorAuthorizationRecord
  ): Promise<ConnectorAuthorizationRecord> {
    return this.runLocallySerialized(initial.id, async () => {
      let authorization = await this.requireStableActiveAuthorization(definition, initial.id)
      if (authorization.revision !== initial.revision) return authorization
      authorization = await this.prepareAuthorizationForMutation(
        definition,
        authorization,
        "refresh"
      )
      if (authorization.revision !== initial.revision) return authorization
      const claimOutcome = await this.claimCredentialMutation(definition, authorization, "refresh")
      if (claimOutcome.type === "superseded") return claimOutcome.authorization
      const { claim } = claimOutcome

      let current: ConnectorOAuthCredentials
      try {
        current = await this.openCredentials(definition.id, claim.authorization)
      } catch (error) {
        await recoverConnectorFailure(
          error,
          "Connector credential mutation could not be released after credential decryption failed.",
          () => this.releaseCredentialMutation(claim.authorization)
        )
        throw createConnectorCodedError(
          "connector.credentials_unavailable",
          "Stored connector credentials could not be opened.",
          { cause: error }
        )
      }
      if (!current.refreshToken) {
        const error = createConnectorCodedError(
          "connector.authorization_required",
          "Connector credentials require reauthorization."
        )
        await recoverConnectorFailure(
          error,
          "Connector authorization could not be marked for reauthorization after finding no refresh token.",
          () => this.markNeedsReauthorization(claim.authorization)
        )
        throw error
      }

      try {
        await this.executeCredentialMutation(claim.authorization, async (executing, signal) => {
          const refreshed = validateCredentials(
            await definition.adapter.authentication.refresh(
              this.adapterContext(definition.id, signal),
              current
            )
          )
          assertOperationActive(signal)
          const normalized: ConnectorOAuthCredentials = {
            ...refreshed,
            ...(refreshed.refreshToken === undefined ? { refreshToken: current.refreshToken } : {}),
          }
          const envelope = await this.sealCredentials(definition.id, authorization.id, normalized)
          assertOperationActive(signal)
          const staged = await this.connectionStorage.stageCredentialMutationCredentials({
            ...mutationFence(executing),
            holderId: this.mutationHolderId,
            credentials: envelope,
            ...(normalized.expiresAt === undefined
              ? {}
              : { credentialExpiresAt: normalized.expiresAt }),
            scopes: normalized.scopes ?? authorization.scopes,
          })
          if (!staged) throw createAmbiguousProviderOperationError()
          return staged
        })
      } catch (error) {
        const latest = await recoverConnectorFailure(
          error,
          "Connector refresh outcome could not be recovered from storage.",
          () => this.requireAuthorization(definition.id, authorization.id)
        )
        if (isStagedMutation(latest, claim.authorization.credentialMutation!.id, "refresh")) {
          return recoverConnectorFailure(
            error,
            "Staged connector refresh could not be finalized during recovery.",
            () => this.finalizeStagedMutation(definition, latest)
          )
        }
        if (oauthErrorKind(error) === "retryable") {
          await recoverConnectorFailure(
            error,
            "Connector refresh mutation could not be released after a retryable provider failure.",
            () => this.releaseCredentialMutation(claim.authorization)
          )
          throw createConnectorCodedError(
            "connector.provider_unavailable",
            "Connector credential refresh failed; retry later.",
            { cause: error }
          )
        }
        const marked = await recoverConnectorFailure(
          error,
          "Connector authorization could not be failed closed after an ambiguous refresh.",
          () => this.markNeedsReauthorization(claim.authorization)
        )
        if (marked) {
          throw createConnectorCodedError(
            "connector.authorization_required",
            "Connector credentials require reauthorization.",
            { cause: error }
          )
        }
        const recovered = await recoverConnectorFailure(
          error,
          "Connector refresh state could not be reloaded after failed closed recovery.",
          () => this.requireAuthorization(definition.id, authorization.id)
        )
        if (recovered.revision !== authorization.revision && recovered.status === "active") {
          return recovered
        }
        throw authorizationStatusError(recovered.status)
      }

      const staged = await this.requireAuthorization(definition.id, authorization.id)
      return this.finalizeStagedMutation(definition, staged)
    })
  }

  private async claimCredentialMutation<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    initial: ConnectorAuthorizationRecord,
    kind: ConnectorCredentialMutationKind,
    expectedConnectionIds?: readonly string[]
  ): Promise<CredentialMutationClaimOutcome> {
    const waitDeadline = Date.now() + MUTATION_WAIT_MS
    const initialRevision = initial.revision
    let authorization = initial
    while (true) {
      const claimed = await this.connectionStorage.claimCredentialMutation({
        projectId: this.projectId,
        connectorId: definition.id,
        authorizationId: authorization.id,
        expectedRevision: authorization.revision,
        mutation: {
          id: `ccm_${randomUUID()}`,
          kind,
          holderId: this.mutationHolderId,
        },
        ...(expectedConnectionIds === undefined ? {} : { expectedConnectionIds }),
        leaseDurationMs: this.credentialMutationLeaseMs,
        operationTimeoutMs: this.credentialMutationTimeoutMs,
      })
      if (claimed) return { type: "claimed", claim: claimed }

      await delay(MUTATION_POLL_MS)
      authorization = await this.prepareAuthorizationForMutation(definition, authorization, kind)
      if (kind === "reauthorization" && authorization.status === "revoked") {
        throw createConnectorCodedError(
          "connector.authorization_invalid",
          "Revoked connector credentials cannot be reauthorized."
        )
      }
      if (kind === "reauthorization" && authorization.status === "revocation_pending") {
        throw createConnectorCodedError(
          "connector.authorization_invalid",
          "Connector authorization revocation is pending."
        )
      }
      if (kind === "revocation" && authorization.status === "revoked") {
        return { type: "superseded", authorization }
      }
      if (kind === "refresh" && authorization.revision !== initialRevision) {
        if (authorization.status !== "active") throw authorizationStatusError(authorization.status)
        return { type: "superseded", authorization }
      }
      if (kind === "reauthorization" && expectedConnectionIds) {
        await this.assertAttachedConnections(authorization.id, expectedConnectionIds)
      }
      if (Date.now() >= waitDeadline) {
        throw createConnectorCodedError(
          "connector.operation_in_progress",
          "Connector credentials are being changed by another operation; retry shortly."
        )
      }
    }
  }

  private async prepareAuthorizationForMutation<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    initial: ConnectorAuthorizationRecord,
    requestedKind: ConnectorCredentialMutationKind
  ): Promise<ConnectorAuthorizationRecord> {
    const authorization = await this.requireAuthorization(definition.id, initial.id)
    const mutation = authorization.credentialMutation
    if (!mutation) return authorization

    if (mutation.phase === "result_staged") {
      if (requestedKind === "revocation" && mutation.kind !== "revocation") {
        const marked = await this.markNeedsReauthorization(authorization)
        return marked ?? this.requireAuthorization(definition.id, authorization.id)
      }
      return this.finalizeStagedMutation(definition, authorization)
    }

    const recovered = await this.connectionStorage.recoverExpiredCredentialMutation({
      projectId: this.projectId,
      connectorId: definition.id,
      authorizationId: authorization.id,
    })
    if (recovered) return recovered
    return authorization
  }

  private async executeCredentialMutation<T>(
    authorization: ConnectorAuthorizationRecord,
    run: (executing: ConnectorAuthorizationRecord, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const mutation = authorization.credentialMutation
    if (!mutation) {
      throw createConnectorCodedError(
        "internal.unexpected",
        "Connector credential mutation was not claimed."
      )
    }
    const executing = await this.connectionStorage.markCredentialMutationExecuting({
      ...mutationFence(authorization),
      holderId: this.mutationHolderId,
    })
    if (!executing) throw createAmbiguousProviderOperationError()
    return this.withCredentialMutationSignal(executing, (signal) => run(executing, signal))
  }

  private async withCredentialMutationSignal<T>(
    authorization: ConnectorAuthorizationRecord,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController()
    const hostSignal = this.abortController.signal
    const abortFromHost = () => controller.abort(createAmbiguousProviderOperationError())
    hostSignal.addEventListener("abort", abortFromHost, { once: true })
    const timeout = setTimeout(
      () => controller.abort(createAmbiguousProviderOperationError()),
      this.credentialMutationTimeoutMs
    )
    const heartbeat = setInterval(
      () => {
        void this.connectionStorage
          .renewCredentialMutation({
            ...mutationFence(authorization),
            holderId: this.mutationHolderId,
            leaseDurationMs: this.credentialMutationLeaseMs,
          })
          .then((renewed) => {
            if (!renewed) controller.abort(createAmbiguousProviderOperationError())
          })
          .catch((error) =>
            controller.abort(createAmbiguousProviderOperationError({ cause: error }))
          )
      },
      Math.max(5, Math.floor(this.credentialMutationLeaseMs / 3))
    )

    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAborted = () => reject(abortReason(controller.signal))
      if (controller.signal.aborted) rejectAborted()
      else controller.signal.addEventListener("abort", rejectAborted, { once: true })
    })
    const operation = Promise.resolve().then(() => run(controller.signal))
    operation.catch(() => {})
    try {
      return await Promise.race([operation, aborted])
    } finally {
      clearInterval(heartbeat)
      clearTimeout(timeout)
      hostSignal.removeEventListener("abort", abortFromHost)
    }
  }

  private async withBoundedProviderSignal<T>(
    run: (signal: AbortSignal) => Promise<T> | T
  ): Promise<T> {
    const controller = new AbortController()
    const hostSignal = this.abortController.signal
    const abortFromHost = () => controller.abort(createAmbiguousProviderOperationError())
    hostSignal.addEventListener("abort", abortFromHost, { once: true })
    const timeout = setTimeout(
      () => controller.abort(createAmbiguousProviderOperationError()),
      this.credentialMutationTimeoutMs
    )
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAborted = () => reject(abortReason(controller.signal))
      if (controller.signal.aborted) rejectAborted()
      else controller.signal.addEventListener("abort", rejectAborted, { once: true })
    })
    const operation = Promise.resolve().then(() => run(controller.signal))
    operation.catch(() => {})
    try {
      return await Promise.race([operation, aborted])
    } finally {
      clearTimeout(timeout)
      hostSignal.removeEventListener("abort", abortFromHost)
    }
  }

  private async finalizeStagedMutation<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    authorization: ConnectorAuthorizationRecord
  ): Promise<ConnectorAuthorizationRecord> {
    const mutation = authorization.credentialMutation
    if (!mutation || mutation.phase !== "result_staged") return authorization
    const fence = mutationFence(authorization)
    let finalized: ConnectorAuthorizationRecord | null
    if (mutation.kind === "refresh") {
      finalized = await this.connectionStorage.finalizeRefresh(fence)
    } else if (mutation.kind === "revocation") {
      finalized = await this.connectionStorage.finalizeRevocation(fence)
    } else {
      const staged = mutation.stagedCredentials
      if (!staged) {
        throw createConnectorCodedError(
          "internal.unexpected",
          "Staged connector credentials are missing."
        )
      }
      const credentials = await this.openSealedCredentials(
        definition.id,
        authorization.id,
        staged.credentials
      )
      let accounts: readonly ConnectorAccountCandidate[]
      try {
        accounts = validateAccounts(
          await definition.adapter.discoverAccounts(this.adapterContext(definition.id), credentials)
        )
      } catch (error) {
        throw providerBoundaryError(
          error,
          "connector.provider_failed",
          "Connector account discovery failed; reauthorization remains safely staged."
        )
      }
      try {
        finalized = await this.connectionStorage.finalizeReauthorization({
          ...fence,
          accounts,
        })
      } catch (error) {
        if (isConnectorStorageError(error)) {
          await recoverConnectorFailure(
            error,
            "Connector authorization could not be failed closed after incompatible account discovery.",
            () => this.markNeedsReauthorization(authorization)
          )
          throw createConnectorCodedError(
            "connector.authorization_required",
            "Reauthorized connector accounts changed incompatibly; reauthorization is required.",
            { cause: error }
          )
        }
        throw error
      }
    }
    if (finalized) return finalized
    const latest = await this.requireAuthorization(definition.id, authorization.id)
    if (latest.revision !== authorization.revision || !latest.credentialMutation) return latest
    throw createConnectorCodedError(
      "internal.unexpected",
      "Connector credential mutation could not be finalized safely."
    )
  }

  private async markNeedsReauthorization(
    authorization: ConnectorAuthorizationRecord
  ): Promise<ConnectorAuthorizationRecord | null> {
    if (!authorization.credentialMutation) return null
    return this.connectionStorage.markNeedsReauthorization(mutationFence(authorization))
  }

  private async releaseCredentialMutation(
    authorization: ConnectorAuthorizationRecord
  ): Promise<boolean> {
    if (!authorization.credentialMutation) return false
    return this.connectionStorage.releaseCredentialMutation({
      ...mutationFence(authorization),
      holderId: this.mutationHolderId,
    })
  }

  private async requireStableActiveAuthorization<TAdapter extends OAuthConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    authorizationId: string
  ): Promise<ConnectorAuthorizationRecord> {
    const waitDeadline = Date.now() + MUTATION_WAIT_MS
    while (true) {
      let authorization = await this.requireAuthorization(definition.id, authorizationId)
      if (authorization.credentialMutation) {
        authorization = await this.prepareAuthorizationForMutation(
          definition,
          authorization,
          "refresh"
        )
        if (authorization.credentialMutation) {
          if (Date.now() >= waitDeadline) {
            throw createConnectorCodedError(
              "connector.operation_in_progress",
              "Connector credentials are being changed by another operation; retry shortly."
            )
          }
          await delay(MUTATION_POLL_MS)
          continue
        }
      }
      if (authorization.status !== "active") throw authorizationStatusError(authorization.status)
      return authorization
    }
  }

  private async assertAttachedConnections(
    authorizationId: string,
    expectedConnectionIds: readonly string[]
  ): Promise<void> {
    const attachedIds = (
      await this.connectionStorage.listConnectionsByAuthorization(authorizationId)
    ).map((connection) => connection.id)
    if (!sameIds(attachedIds, expectedConnectionIds)) {
      throw createConnectorCodedError(
        "connector.operation_conflict",
        "Connections attached to this authorization changed; restart reauthorization."
      )
    }
  }

  private async runLocallySerialized<T>(
    authorizationId: string,
    run: () => Promise<T>
  ): Promise<T> {
    const previous = this.localMutationTails.get(authorizationId) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(run)
    const tail = operation.then(
      () => undefined,
      () => undefined
    )
    this.localMutationTails.set(authorizationId, tail)
    try {
      return await operation
    } finally {
      if (this.localMutationTails.get(authorizationId) === tail) {
        this.localMutationTails.delete(authorizationId)
      }
    }
  }

  private managementActor(runtime: ConnectorManagementRuntime, connectorId: string) {
    assertCanManageConnector(runtime, connectorId)
    const resolved = assertRuntimeAuthorizationBound(runtime)
    if (resolved.type !== "principal" || resolved.executionBinding) {
      throw new AuthorizationError(
        `manage:connector:${connectorId}`,
        "[Sixb] Connector connections can only be managed by an authorized principal request."
      )
    }
    if (!resolved.ref.credential) {
      throw new AuthorizationError(
        `manage:connector:${connectorId}`,
        "[Sixb] Starting or completing connector authorization requires a session or access token."
      )
    }
    return { principal: resolved.ref.principal, credential: resolved.ref.credential }
  }

  private async requireAuthorization(
    connectorId: string,
    authorizationId: string
  ): Promise<ConnectorAuthorizationRecord> {
    const authorization = await this.connectionStorage.getAuthorization(authorizationId)
    if (
      !authorization ||
      authorization.projectId !== this.projectId ||
      authorization.connectorId !== connectorId
    ) {
      throw createConnectorCodedError(
        "connector.not_found",
        "Connector authorization was not found."
      )
    }
    return authorization
  }

  private async sealCredentials(
    connectorId: string,
    authorizationId: string,
    credentials: ConnectorOAuthCredentials
  ) {
    return this.credentialProtector.seal(textEncoder.encode(serializeCredentials(credentials)), {
      projectId: this.projectId,
      connectorId,
      recordId: authorizationId,
      purpose: "oauth-authorization",
    })
  }

  private async openCredentials(
    connectorId: string,
    authorization: ConnectorAuthorizationRecord
  ): Promise<ConnectorOAuthCredentials> {
    return this.openSealedCredentials(connectorId, authorization.id, authorization.credentials)
  }

  private async openSealedCredentials(
    connectorId: string,
    authorizationId: string,
    credentials: ConnectorAuthorizationRecord["credentials"]
  ): Promise<ConnectorOAuthCredentials> {
    const plaintext = await this.credentialProtector.open(credentials, {
      projectId: this.projectId,
      connectorId,
      recordId: authorizationId,
      purpose: "oauth-authorization",
    })
    return parseCredentials(textDecoder.decode(plaintext))
  }

  private adapterContext(connectorId: string, signal = this.abortController.signal) {
    return { projectId: this.projectId, connectorId, signal }
  }

  private authorizationAdapterContext(
    connectorId: string,
    redirectUri: string,
    signal = this.abortController.signal
  ) {
    return { ...this.adapterContext(connectorId, signal), redirectUri }
  }

  private assertRegistered(definition: ConnectorDefinition): void {
    const registeredDefinition = this.definitionsById.get(definition.id)
    if (!registeredDefinition) {
      throw createConnectorCodedError(
        "connector.not_found",
        `Unknown connector '${definition.id}'.`
      )
    }
    if (registeredDefinition !== definition) {
      throw createConnectorCodedError(
        "connector.configuration_invalid",
        `Connector '${definition.id}' is not the registered definition instance.`
      )
    }
  }

  private assertOAuthRegistered(
    definition: ConnectorDefinition
  ): asserts definition is ConnectorDefinition<string, OAuthConnectorAdapter> {
    this.assertRegistered(definition)
    if (!isOAuthConnectorDefinition(definition)) {
      throw createConnectorCodedError(
        "connector.configuration_invalid",
        `Connector '${definition.id}' does not use OAuth authentication.`
      )
    }
  }
}

class ConnectorConnectionTokenSource {
  private deliveredRevision: number | undefined
  private rejectedRevision: number | undefined

  constructor(
    private readonly service: ConnectorConnectionService,
    private readonly definition: ConnectorDefinition<string, OAuthConnectorAdapter>,
    private readonly authorizationId: string
  ) {}

  async get(): Promise<{ readonly accessToken: string; readonly tokenType?: string }> {
    const result = await this.service.getAccessToken(
      this.definition,
      this.authorizationId,
      this.rejectedRevision
    )
    this.deliveredRevision = result.revision
    this.rejectedRevision = undefined
    return result.token
  }

  invalidate(): void {
    this.rejectedRevision = this.deliveredRevision
  }
}

function mutationFence(authorization: ConnectorAuthorizationRecord) {
  const mutation = authorization.credentialMutation
  if (!mutation) {
    throw createConnectorCodedError(
      "internal.unexpected",
      "Connector credential mutation is missing."
    )
  }
  return {
    projectId: authorization.projectId,
    connectorId: authorization.connectorId,
    authorizationId: authorization.id,
    expectedRevision: authorization.revision,
    mutationId: mutation.id,
  }
}

function isStagedMutation(
  authorization: ConnectorAuthorizationRecord,
  mutationId: string,
  kind: ConnectorCredentialMutationKind
): boolean {
  return (
    authorization.credentialMutation?.id === mutationId &&
    authorization.credentialMutation.kind === kind &&
    authorization.credentialMutation.phase === "result_staged"
  )
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : createAmbiguousProviderOperationError()
}

function assertOperationActive(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}

function assertSelector(selector: ConnectorConnectionSelector): void {
  if (selector.owner.type !== "project") {
    throw createConnectorCodedError(
      "connector.configuration_invalid",
      "Connector connections only support project ownership in V1."
    )
  }
  nonblank(selector.slot, "connection slot")
}

function assertAuthorizationActor(
  authorization: ConnectorAuthorizationRecord,
  principal: AuthorizationContext["principal"]
): void {
  if (
    authorization.authorizedBy.type !== principal.type ||
    authorization.authorizedBy.id !== principal.id
  ) {
    throw new AuthorizationError(
      `authorization:connector:${authorization.connectorId}`,
      "[Sixb] This connector authorization can only be changed by its authorizing principal."
    )
  }
}

function authorizationStatusError(
  status: ConnectorAuthorizationRecord["status"]
): ReturnType<typeof createConnectorCodedError> {
  if (status === "needs_reauthorization") {
    return createConnectorCodedError(
      "connector.authorization_required",
      "Connector credentials require reauthorization."
    )
  }
  if (status === "pending_selection") {
    return createConnectorCodedError(
      "connector.authorization_required",
      "Connector authorization requires account selection."
    )
  }
  if (status === "revocation_pending") {
    return createConnectorCodedError(
      "connector.authorization_required",
      "Connector authorization revocation is pending."
    )
  }
  return createConnectorCodedError(
    "connector.authorization_required",
    "Connector authorization has been revoked."
  )
}

function connectionView(
  connection: ConnectorConnectionRecord,
  status: ConnectorAuthorizationRecord["status"]
): ConnectorConnectionView {
  return {
    id: connection.id,
    connectorId: connection.connectorId,
    owner: connection.owner,
    slot: connection.slot,
    account: connection.account,
    status,
  }
}
