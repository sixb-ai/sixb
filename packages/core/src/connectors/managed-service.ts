import { createHash, randomBytes, randomUUID } from "node:crypto"
import {
  type AuthorizationContext,
  AuthorizationError,
  assertCanManageConnector,
} from "../authorization"
import { assertRuntimeAuthorizationBound } from "../authorization/decision"
import type { RuntimeAuthorization } from "../execution"
import type {
  ConnectorAuthorizationRecord,
  ConnectorConnectionRecord,
  ConnectorConnectionStorage,
} from "../storage"
import {
  type ConnectorCredentialProtector,
  createEphemeralConnectorCredentialProtector,
} from "./credentials"
import { ConnectorError, ConnectorNotFoundError, ConnectorOAuthError } from "./errors"
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
} from "./managed-validation"
import type {
  ConnectorAccountCandidate,
  ConnectorClient,
  ConnectorConnectionSelector,
  ConnectorDefinition,
  ConnectorOAuthCredentials,
  ManagedConnectorAdapter,
} from "./types"
import { isManagedConnectorDefinition } from "./types"

const DEFAULT_ATTEMPT_TTL_MS = 10 * 60_000
const DEFAULT_REFRESH_LEASE_MS = 30_000
const DEFAULT_REFRESH_SKEW_MS = 60_000
const REFRESH_POLL_MS = 25
const REFRESH_WAIT_MS = 5_000
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export interface ConnectorManagementRuntime {
  readonly runtimeAuthorization?: RuntimeAuthorization
  readonly authorization?: AuthorizationContext
}

export interface ManagedConnectorServiceOptions {
  readonly storage?: ConnectorConnectionStorage
  readonly credentialProtector?: ConnectorCredentialProtector
  readonly authorizationAttemptTtlMs?: number
  readonly refreshLeaseMs?: number
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

/** Framework-owned OAuth lifecycle for managed connector definitions. */
export class ManagedConnectorService {
  private readonly definitionsById: ReadonlyMap<string, ConnectorDefinition>
  private abortController = new AbortController()
  private readonly managedStorage: ConnectorConnectionStorage
  private readonly credentialProtector: ConnectorCredentialProtector
  private readonly authorizationAttemptTtlMs: number
  private readonly refreshLeaseMs: number
  private readonly refreshSkewMs: number
  private readonly now: () => Date
  private readonly refreshHolderId = `connector-service-${randomUUID()}`
  private readonly refreshes = new Map<string, Promise<ConnectorAuthorizationRecord>>()

  constructor(
    private readonly projectId: string,
    definitions: readonly ConnectorDefinition[],
    options: ManagedConnectorServiceOptions = {}
  ) {
    this.definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
    this.authorizationAttemptTtlMs = positiveDuration(
      options.authorizationAttemptTtlMs ?? DEFAULT_ATTEMPT_TTL_MS,
      "authorization attempt TTL"
    )
    this.refreshLeaseMs = positiveDuration(
      options.refreshLeaseMs ?? DEFAULT_REFRESH_LEASE_MS,
      "refresh lease duration"
    )
    this.refreshSkewMs = nonNegativeDuration(
      options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS,
      "refresh skew"
    )
    this.now = options.now ?? (() => new Date())

    if (!options.storage) {
      throw new ConnectorError(
        "Managed connectors require storage.connectorConnections to be configured."
      )
    }
    if (options.storage.durability !== "ephemeral" && options.storage.durability !== "durable") {
      throw new ConnectorError(
        "Managed connector storage must declare 'ephemeral' or 'durable' durability."
      )
    }
    if (options.storage.durability === "durable" && !options.credentialProtector) {
      throw new ConnectorError(
        "Durable managed connector storage requires connectorCredentials.protector to be configured."
      )
    }
    this.managedStorage = options.storage
    this.credentialProtector =
      options.credentialProtector ?? createEphemeralConnectorCredentialProtector()
  }

  async connectManaged<TAdapter extends ManagedConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    selector: ConnectorConnectionSelector
  ): Promise<ConnectorClient<TAdapter>> {
    this.assertManagedRegistered(definition)
    assertSelector(selector)
    const storage = this.requireManagedStorage()
    const connection = await storage.getConnection({
      projectId: this.projectId,
      connectorId: definition.id,
      ...selector,
    })
    if (!connection) {
      throw new ConnectorError(
        `Managed connector '${definition.id}' has no connection for project slot '${selector.slot}'.`
      )
    }
    const authorization = await this.requireActiveAuthorization(
      definition.id,
      connection.authorizationId
    )
    const tokenSource = new ManagedConnectorTokenSource(this, definition, authorization.id)
    try {
      return (await definition.adapter.connect({
        projectId: this.projectId,
        connectorId: definition.id,
        connectionId: connection.id,
        account: connection.account,
        tokenSource,
        signal: this.abortController.signal,
      })) as ConnectorClient<TAdapter>
    } catch {
      throw new ConnectorError("Managed connector client creation failed.")
    }
  }

  async startAuthorization<TAdapter extends ManagedConnectorAdapter>(
    runtime: ConnectorManagementRuntime,
    definition: ConnectorDefinition<string, TAdapter>,
    input: StartConnectorAuthorizationInput
  ): Promise<StartConnectorAuthorizationResult> {
    this.assertManagedRegistered(definition)
    const actor = this.managementActor(runtime, definition.id)
    assertSelector(input)
    const redirectUri = normalizedHttpUrl(input.redirectUri, "OAuth callback URL")
    const storage = this.requireManagedStorage()
    const protector = this.requireCredentialProtector()
    let affectedConnections: readonly ConnectorConnectionView[] = []
    let reauthorizationConnectionIds: readonly string[] | undefined
    if (input.reauthorizationId !== undefined) {
      const authorization = await this.requireAuthorization(
        definition.id,
        nonblank(input.reauthorizationId, "reauthorization id")
      )
      if (authorization.status === "revoked") {
        throw new ConnectorError("Revoked connector credentials cannot be reauthorized.")
      }
      assertAuthorizationActor(authorization, actor.principal)
      const connections = await storage.listConnectionsByAuthorization(authorization.id)
      reauthorizationConnectionIds = connections.map((connection) => connection.id).sort()
      affectedConnections = connections.map((connection) =>
        connectionView(connection, authorization.status)
      )
    }
    const attemptId = `cat_${randomUUID()}`
    const state = `${attemptId}.${randomBytes(32).toString("base64url")}`
    const codeVerifier = randomBytes(32).toString("base64url")
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
    const now = this.now()
    const context = {
      projectId: this.projectId,
      connectorId: definition.id,
      redirectUri,
      signal: this.abortController.signal,
    }
    let authorizationUrlInput: string | URL
    try {
      authorizationUrlInput = await definition.adapter.authorizationUrl(context, {
        state,
        codeChallenge,
        codeChallengeMethod: "S256",
      })
    } catch {
      throw new ConnectorError("Managed connector authorization could not be started.")
    }
    const authorizationUrl = normalizedHttpUrl(authorizationUrlInput, "provider authorization URL")
    assertAuthorizationUrlParameters(authorizationUrl, { state, codeChallenge })
    const sealedVerifier = await protector.seal(textEncoder.encode(codeVerifier), {
      projectId: this.projectId,
      connectorId: definition.id,
      recordId: attemptId,
      purpose: "pkce-verifier",
    })
    await storage.createAuthorizationAttempt({
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
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.authorizationAttemptTtlMs),
    })
    return { authorizationUrl, affectedConnections }
  }

  async completeAuthorization<TAdapter extends ManagedConnectorAdapter>(
    runtime: ConnectorManagementRuntime,
    definition: ConnectorDefinition<string, TAdapter>,
    input: CompleteConnectorAuthorizationInput
  ): Promise<CompleteConnectorAuthorizationResult> {
    this.assertManagedRegistered(definition)
    const actor = this.managementActor(runtime, definition.id)
    const state = nonblank(input.state, "OAuth state")
    const attemptId = parseAttemptId(state)
    const code = nonblank(input.code, "OAuth authorization code")
    const redirectUri = normalizedHttpUrl(input.redirectUri, "OAuth callback URL")
    const storage = this.requireManagedStorage()
    const protector = this.requireCredentialProtector()
    const attempt = await storage.consumeAuthorizationAttempt({
      id: attemptId,
      projectId: this.projectId,
      connectorId: definition.id,
      authorizedBy: actor.principal,
      credential: actor.credential,
      stateHash: hashSecret(state),
      redirectUri,
      now: this.now(),
    })
    let reauthorization: ConnectorAuthorizationRecord | undefined
    if (attempt.reauthorizationId !== undefined) {
      reauthorization = await this.requireAuthorization(definition.id, attempt.reauthorizationId)
      if (reauthorization.status === "revoked") {
        throw new ConnectorError("Revoked connector credentials cannot be reauthorized.")
      }
      assertAuthorizationActor(reauthorization, actor.principal)
      const attachedIds = (await storage.listConnectionsByAuthorization(reauthorization.id)).map(
        (connection) => connection.id
      )
      if (!sameIds(attachedIds, attempt.reauthorizationConnectionIds ?? [])) {
        throw new ConnectorError(
          "Connections attached to this authorization changed; restart reauthorization."
        )
      }
    }
    const verifierBytes = await protector.open(attempt.codeVerifier, {
      projectId: this.projectId,
      connectorId: definition.id,
      recordId: attempt.id,
      purpose: "pkce-verifier",
    })
    const context = {
      projectId: this.projectId,
      connectorId: definition.id,
      redirectUri,
      signal: this.abortController.signal,
    }
    let exchangedCredentials: ConnectorOAuthCredentials
    try {
      exchangedCredentials = await definition.adapter.exchangeCode(context, {
        code,
        codeVerifier: textDecoder.decode(verifierBytes),
      })
    } catch {
      throw new ConnectorError("Managed connector authorization code exchange failed.")
    }
    const credentials = validateCredentials(exchangedCredentials)
    let discoveredAccounts: readonly ConnectorAccountCandidate[]
    try {
      discoveredAccounts = await definition.adapter.discoverAccounts(context, credentials)
    } catch {
      throw new ConnectorError("Managed connector account discovery failed.")
    }
    const accounts = validateAccounts(discoveredAccounts)
    const authorizationId = attempt.reauthorizationId ?? `cau_${randomUUID()}`
    const credentialsEnvelope = await this.sealCredentials(
      definition.id,
      authorizationId,
      credentials
    )
    const now = this.now()
    if (attempt.reauthorizationId === undefined) {
      await storage.createAuthorization({
        id: authorizationId,
        projectId: this.projectId,
        connectorId: definition.id,
        authorizedBy: actor.principal,
        credentials: credentialsEnvelope,
        ...(credentials.expiresAt === undefined
          ? {}
          : { credentialExpiresAt: credentials.expiresAt }),
        scopes: credentials.scopes ?? [],
        accounts,
        createdAt: now,
      })
    } else {
      const updated = await storage.reauthorizeAuthorization({
        authorizationId,
        expectedRevision: reauthorization!.revision,
        expectedConnectionIds: attempt.reauthorizationConnectionIds ?? [],
        credentials: credentialsEnvelope,
        ...(credentials.expiresAt === undefined
          ? {}
          : { credentialExpiresAt: credentials.expiresAt }),
        scopes: credentials.scopes ?? [],
        accounts,
        updatedAt: now,
      })
      if (!updated) {
        throw new ConnectorError("Connector authorization changed; restart reauthorization.")
      }
    }
    return {
      authorizationId,
      owner: attempt.owner,
      slot: attempt.slot,
      accounts,
    }
  }

  async selectAccount<TAdapter extends ManagedConnectorAdapter>(
    runtime: ConnectorManagementRuntime,
    definition: ConnectorDefinition<string, TAdapter>,
    input: SelectConnectorAccountInput
  ): Promise<ConnectorConnectionView> {
    this.assertManagedRegistered(definition)
    const actor = this.managementActor(runtime, definition.id)
    assertSelector(input)
    const authorization = await this.requireActiveAuthorization(
      definition.id,
      input.authorizationId
    )
    assertAuthorizationActor(authorization, actor.principal)
    const account = authorization.accounts.find((candidate) => candidate.id === input.accountId)
    if (!account) {
      throw new ConnectorError(
        `Account '${input.accountId}' is not exposed by this connector authorization.`
      )
    }
    const result = await this.requireManagedStorage().putConnection({
      id: `ccn_${randomUUID()}`,
      projectId: this.projectId,
      connectorId: definition.id,
      owner: input.owner,
      slot: input.slot,
      authorizationId: authorization.id,
      account,
      replace: input.replace === true,
      now: this.now(),
    })
    return connectionView(result.connection, authorization.status)
  }

  async disconnect<TAdapter extends ManagedConnectorAdapter>(
    runtime: ConnectorManagementRuntime,
    definition: ConnectorDefinition<string, TAdapter>,
    connectionId: string
  ): Promise<ConnectorConnectionView | null> {
    this.assertManagedRegistered(definition)
    this.managementActor(runtime, definition.id)
    const storage = this.requireManagedStorage()
    const connection = await storage.getConnectionById(nonblank(connectionId, "connection id"))
    if (
      !connection ||
      connection.projectId !== this.projectId ||
      connection.connectorId !== definition.id
    ) {
      return null
    }
    const authorization = await storage.getAuthorization(connection.authorizationId)
    const disconnected = await storage.disconnectConnection({
      projectId: this.projectId,
      connectorId: definition.id,
      connectionId,
    })
    return disconnected
      ? connectionView(disconnected, authorization?.status ?? "needs_reauthorization")
      : null
  }

  async revokeAuthorization<TAdapter extends ManagedConnectorAdapter>(
    runtime: ConnectorManagementRuntime,
    definition: ConnectorDefinition<string, TAdapter>,
    authorizationId: string
  ): Promise<RevokeConnectorAuthorizationResult> {
    this.assertManagedRegistered(definition)
    const actor = this.managementActor(runtime, definition.id)
    const authorization = await this.requireAuthorization(
      definition.id,
      nonblank(authorizationId, "authorization id")
    )
    assertAuthorizationActor(authorization, actor.principal)
    const result = await this.requireManagedStorage().revokeAuthorization({
      projectId: this.projectId,
      connectorId: definition.id,
      authorizationId: authorization.id,
      expectedRevision: authorization.revision,
      revokedAt: this.now(),
    })
    if (!result) {
      throw new ConnectorError("Connector authorization changed; retry the revocation.")
    }

    if (definition.adapter.revoke) {
      try {
        const credentials = await this.openCredentials(definition.id, result.authorization)
        await definition.adapter.revoke(this.adapterContext(definition.id), credentials)
      } catch {
        throw new ConnectorError(
          "Connector authorization was revoked locally, but provider revocation failed."
        )
      }
    }
    return {
      affectedConnections: result.disconnected.map((connection) =>
        connectionView(connection, "revoked")
      ),
    }
  }

  async close(): Promise<void> {
    this.abortController.abort()
    this.abortController = new AbortController()
  }

  async getAccessToken<TAdapter extends ManagedConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    authorizationId: string,
    forceRefresh: boolean
  ): Promise<{ readonly accessToken: string; readonly tokenType?: string }> {
    let authorization = await this.requireActiveAuthorization(definition.id, authorizationId)
    const credentials = await this.openCredentials(definition.id, authorization)
    if (forceRefresh || shouldRefresh(authorization, this.now(), this.refreshSkewMs)) {
      authorization = await this.refreshAuthorization(definition, authorization)
      const refreshed = await this.openCredentials(definition.id, authorization)
      return tokenView(refreshed)
    }
    return tokenView(credentials)
  }

  private async refreshAuthorization<TAdapter extends ManagedConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    authorization: ConnectorAuthorizationRecord
  ): Promise<ConnectorAuthorizationRecord> {
    const existing = this.refreshes.get(authorization.id)
    if (existing) return existing
    const refresh = this.performRefresh(definition, authorization).finally(() => {
      if (this.refreshes.get(authorization.id) === refresh) this.refreshes.delete(authorization.id)
    })
    this.refreshes.set(authorization.id, refresh)
    return refresh
  }

  private async performRefresh<TAdapter extends ManagedConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    initial: ConnectorAuthorizationRecord
  ): Promise<ConnectorAuthorizationRecord> {
    const storage = this.requireManagedStorage()
    let authorization = initial
    const waitDeadline = Date.now() + REFRESH_WAIT_MS
    while (true) {
      const leaseId = `crl_${randomUUID()}`
      const claimed = await storage.claimRefreshLease({
        authorizationId: authorization.id,
        expectedRevision: authorization.revision,
        lease: {
          id: leaseId,
          holderId: this.refreshHolderId,
        },
        durationMs: this.refreshLeaseMs,
      })
      if (claimed) return this.refreshWithLease(definition, claimed, leaseId)

      await delay(REFRESH_POLL_MS)
      const latest = await this.requireActiveAuthorization(definition.id, authorization.id)
      if (latest.revision !== authorization.revision) return latest
      authorization = latest
      if (Date.now() >= waitDeadline) {
        throw new ConnectorError("Connector credentials are being refreshed; retry shortly.")
      }
    }
  }

  private async refreshWithLease<TAdapter extends ManagedConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>,
    authorization: ConnectorAuthorizationRecord,
    leaseId: string
  ): Promise<ConnectorAuthorizationRecord> {
    const storage = this.requireManagedStorage()
    let current: ConnectorOAuthCredentials
    try {
      current = await this.openCredentials(definition.id, authorization)
    } catch {
      await storage.releaseRefreshLease({
        authorizationId: authorization.id,
        expectedRevision: authorization.revision,
        leaseId,
        updatedAt: this.now(),
      })
      throw new ConnectorError("Stored connector credentials could not be opened.")
    }
    if (!current.refreshToken) {
      const marked = await storage.markNeedsReauthorization({
        authorizationId: authorization.id,
        expectedRevision: authorization.revision,
        leaseId,
        updatedAt: this.now(),
      })
      throw new ConnectorError(
        marked
          ? "Connector credentials require reauthorization."
          : "Connector authorization changed while refresh was starting."
      )
    }

    let refreshed: ConnectorOAuthCredentials
    try {
      refreshed = validateCredentials(
        await definition.adapter.refresh(this.adapterContext(definition.id), current)
      )
    } catch (error) {
      if (error instanceof ConnectorOAuthError && error.kind === "terminal") {
        const marked = await storage.markNeedsReauthorization({
          authorizationId: authorization.id,
          expectedRevision: authorization.revision,
          leaseId,
          updatedAt: this.now(),
        })
        if (marked) {
          throw new ConnectorError("Connector credentials require reauthorization.")
        }
        const latest = await this.requireActiveAuthorization(definition.id, authorization.id)
        if (latest.revision !== authorization.revision) return latest
        throw new ConnectorError("Connector authorization changed while refresh was failing.")
      }
      await storage.releaseRefreshLease({
        authorizationId: authorization.id,
        expectedRevision: authorization.revision,
        leaseId,
        updatedAt: this.now(),
      })
      throw new ConnectorError("Connector credential refresh failed; retry later.")
    }

    const normalized: ConnectorOAuthCredentials = {
      ...refreshed,
      ...(refreshed.refreshToken === undefined ? { refreshToken: current.refreshToken } : {}),
    }
    let envelope: Awaited<ReturnType<ManagedConnectorService["sealCredentials"]>>
    try {
      envelope = await this.sealCredentials(definition.id, authorization.id, normalized)
    } catch {
      await storage.markNeedsReauthorization({
        authorizationId: authorization.id,
        expectedRevision: authorization.revision,
        leaseId,
        updatedAt: this.now(),
      })
      throw new ConnectorError("Refreshed connector credentials could not be persisted safely.")
    }
    const updated = await storage.updateAuthorizationCredentials({
      authorizationId: authorization.id,
      expectedRevision: authorization.revision,
      leaseId,
      credentials: envelope,
      ...(normalized.expiresAt === undefined ? {} : { credentialExpiresAt: normalized.expiresAt }),
      scopes: normalized.scopes ?? authorization.scopes,
      updatedAt: this.now(),
    })
    if (!updated) {
      const latest = await this.requireActiveAuthorization(definition.id, authorization.id)
      if (latest.revision !== authorization.revision) return latest
      throw new ConnectorError("Connector authorization changed while refresh was completing.")
    }
    return updated
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
    const authorization = await this.requireManagedStorage().getAuthorization(authorizationId)
    if (
      !authorization ||
      authorization.projectId !== this.projectId ||
      authorization.connectorId !== connectorId
    ) {
      throw new ConnectorError("Connector authorization was not found.")
    }
    return authorization
  }

  private async requireActiveAuthorization(
    connectorId: string,
    authorizationId: string
  ): Promise<ConnectorAuthorizationRecord> {
    const authorization = await this.requireAuthorization(connectorId, authorizationId)
    if (authorization.status !== "active") {
      throw new ConnectorError(
        authorization.status === "needs_reauthorization"
          ? "Connector credentials require reauthorization."
          : "Connector authorization has been revoked."
      )
    }
    return authorization
  }

  private async sealCredentials(
    connectorId: string,
    authorizationId: string,
    credentials: ConnectorOAuthCredentials
  ) {
    return this.requireCredentialProtector().seal(
      textEncoder.encode(serializeCredentials(credentials)),
      {
        projectId: this.projectId,
        connectorId,
        recordId: authorizationId,
        purpose: "oauth-authorization",
      }
    )
  }

  private async openCredentials(
    connectorId: string,
    authorization: ConnectorAuthorizationRecord
  ): Promise<ConnectorOAuthCredentials> {
    const plaintext = await this.requireCredentialProtector().open(authorization.credentials, {
      projectId: this.projectId,
      connectorId,
      recordId: authorization.id,
      purpose: "oauth-authorization",
    })
    return parseCredentials(textDecoder.decode(plaintext))
  }

  private adapterContext(connectorId: string) {
    return {
      projectId: this.projectId,
      connectorId,
      signal: this.abortController.signal,
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

  private assertManagedRegistered(
    definition: ConnectorDefinition
  ): asserts definition is ConnectorDefinition<string, ManagedConnectorAdapter> {
    this.assertRegistered(definition)
    if (!isManagedConnectorDefinition(definition)) {
      throw new ConnectorError(`Connector '${definition.id}' is not a managed connector.`)
    }
  }

  private requireManagedStorage(): ConnectorConnectionStorage {
    if (!this.managedStorage) {
      throw new ConnectorError("Managed connector storage is not configured.")
    }
    return this.managedStorage
  }

  private requireCredentialProtector(): ConnectorCredentialProtector {
    if (!this.credentialProtector) {
      throw new ConnectorError("Managed connector credential protection is not configured.")
    }
    return this.credentialProtector
  }
}

class ManagedConnectorTokenSource {
  private invalidated = false

  constructor(
    private readonly service: ManagedConnectorService,
    private readonly definition: ConnectorDefinition<string, ManagedConnectorAdapter>,
    private readonly authorizationId: string
  ) {}

  async get(): Promise<{ readonly accessToken: string; readonly tokenType?: string }> {
    const token = await this.service.getAccessToken(
      this.definition,
      this.authorizationId,
      this.invalidated
    )
    this.invalidated = false
    return token
  }

  invalidate(): void {
    this.invalidated = true
  }
}

function assertSelector(selector: ConnectorConnectionSelector): void {
  if (selector.owner.type !== "project") {
    throw new ConnectorError("Managed connector V1 only supports project-owned connections.")
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
