import { randomUUID } from "node:crypto"
import { AuthorizationError } from "../../authorization"
import { isSixbError } from "../../errors/internal"
import type { AuthorizablePrincipal } from "../../execution"
import type {
  ConnectorAuthorizationRecord,
  ConnectorConnectionRecord,
  ConnectorConnectionStorage,
} from "../../storage"
import type { ConnectorCredentialProtector } from "../credentials"
import {
  createConnectorCodedError,
  oauthErrorKind,
  providerBoundaryError,
  recoverConnectorFailure,
  storageBoundaryError,
} from "../errors"
import type {
  ConnectorAccountCandidate,
  ConnectorDefinition,
  ConnectorOAuthCredentials,
  ConnectorTokenSource,
  OAuthConnectorAdapter,
} from "../types"
import { ConnectorCredentialCodec } from "./credential-codec"
import {
  assertCredentialMutationOperationActive,
  ConnectorCredentialMutationCoordinator,
} from "./credential-mutations"
import type {
  CompleteConnectorReauthorizationInput,
  CompleteNewConnectorAuthorizationInput,
  ConnectorAuthorizationLifecycle,
  PrepareConnectorReauthorizationInput,
  PreparedConnectorReauthorization,
} from "./request"
import { withConnectorStorageBoundary } from "./storage-boundary"
import { ConnectorTokenAccess } from "./tokens"
import { positiveDuration, validateAccounts, validateCredentials } from "./validation"

export type OAuthConnectorDefinition = ConnectorDefinition<string, OAuthConnectorAdapter>

export interface ConnectorAuthorizationLifecycleOptions {
  readonly projectId: string
  readonly storage: ConnectorConnectionStorage
  readonly credentialProtector: ConnectorCredentialProtector
  readonly resolveDefinition: (connectorId: string) => OAuthConnectorDefinition
  readonly hostSignal: () => AbortSignal
  readonly accountSelectionTtlMs: number
  readonly credentialMutationLeaseMs: number
  readonly providerOperationTimeoutMs: number
  readonly refreshSkewMs: number
  readonly now: () => Date
}

export interface RevokeConnectorAuthorizationInput {
  readonly definition: OAuthConnectorDefinition
  readonly authorizationId: string
  readonly principal: AuthorizablePrincipal
}

export interface ConnectorAuthorizationRevocation {
  readonly disconnected: readonly ConnectorConnectionRecord[]
}

/**
 * Owns OAuth grants and their encrypted credentials.
 *
 * Request authorization and attempt persistence stay in `request.ts`; provider-side mutations are
 * fenced here through one shared coordinator. The host owns cancellation and exposes its current
 * signal through a callback, so closing and restarting a host never leaves this lifecycle attached
 * to a stale controller.
 */
export class DefaultConnectorAuthorizationLifecycle implements ConnectorAuthorizationLifecycle {
  private readonly projectId: string
  private readonly storage: ConnectorConnectionStorage
  private readonly resolveDefinition: (connectorId: string) => OAuthConnectorDefinition
  private readonly accountSelectionTtlMs: number
  private readonly mutations: ConnectorCredentialMutationCoordinator
  private readonly credentials: ConnectorCredentialCodec
  private readonly tokens: ConnectorTokenAccess

  constructor(options: ConnectorAuthorizationLifecycleOptions) {
    this.projectId = options.projectId
    this.storage = options.storage
    this.resolveDefinition = options.resolveDefinition
    this.accountSelectionTtlMs = positiveDuration(
      options.accountSelectionTtlMs,
      "account selection TTL"
    )
    this.credentials = new ConnectorCredentialCodec({
      projectId: options.projectId,
      protector: options.credentialProtector,
    })
    this.mutations = new ConnectorCredentialMutationCoordinator({
      projectId: options.projectId,
      storage: options.storage,
      leaseDurationMs: options.credentialMutationLeaseMs,
      operationTimeoutMs: options.providerOperationTimeoutMs,
      hostSignal: options.hostSignal,
      discoverReauthorizationAccounts: async (authorization, staged) => {
        const definition = this.definitionFor(authorization.connectorId)
        const credentials = await this.credentials.open(
          definition.id,
          authorization.id,
          staged.credentials
        )
        return this.discoverAccounts(definition, credentials)
      },
    })
    this.tokens = new ConnectorTokenAccess({
      projectId: options.projectId,
      storage: options.storage,
      credentials: this.credentials,
      mutations: this.mutations,
      refreshSkewMs: options.refreshSkewMs,
      now: options.now,
    })
  }

  async prepareReauthorization(
    input: PrepareConnectorReauthorizationInput
  ): Promise<PreparedConnectorReauthorization> {
    this.assertRegistered(input.definition)
    const authorization = await this.requireAuthorization(
      input.definition.id,
      input.authorizationId
    )
    if (authorization.status === "pending_selection") {
      throw createConnectorCodedError(
        "connector.authorization_invalid",
        "Pending connector credentials cannot be reauthorized; restart authorization or select an account."
      )
    }
    if (authorization.status === "revoked" || authorization.status === "revocation_pending") {
      throw createConnectorCodedError(
        "connector.authorization_invalid",
        "Revoked connector credentials cannot be reauthorized."
      )
    }
    assertConnectorAuthorizationActor(authorization, input.principal)
    const connections = await withConnectorStorageBoundary(
      "Connector authorization connections could not be read.",
      () =>
        this.storage.listConnectionsByAuthorization({
          projectId: this.projectId,
          connectorId: input.definition.id,
          authorizationId: authorization.id,
        })
    )
    return { authorization, connections }
  }

  async completeNewAuthorization(
    input: CompleteNewConnectorAuthorizationInput
  ): Promise<ConnectorAuthorizationRecord> {
    this.assertRegistered(input.definition)
    const authorizationId = `cau_${randomUUID()}`
    const credentials = await this.exchangeAuthorizationCode(
      input.definition,
      input.code,
      input.codeVerifier,
      input.redirectUri
    )
    const credentialsEnvelope = await this.credentials.seal(
      input.definition.id,
      authorizationId,
      credentials
    )

    let pending: ConnectorAuthorizationRecord
    try {
      pending = await this.storage.createAuthorization({
        id: authorizationId,
        projectId: this.projectId,
        connectorId: input.definition.id,
        authorizedBy: input.principal,
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
      accounts = await this.discoverAccounts(input.definition, credentials)
    } catch (error) {
      const discoveryError = providerBoundaryError(
        error,
        "connector.provider_failed",
        "Connector account discovery failed; the unused authorization is being revoked."
      )
      await this.revokeAbandonedAuthorization(
        input.definition,
        authorizationId,
        input.principal,
        discoveryError
      )
      throw discoveryError
    }
    const initialized = await withConnectorStorageBoundary(
      "Connector authorization accounts could not be persisted.",
      () =>
        this.storage.initializeAuthorizationAccounts({
          projectId: this.projectId,
          connectorId: input.definition.id,
          authorizationId,
          expectedRevision: pending.revision,
          accounts,
        })
    )
    if (!initialized) {
      throw createConnectorCodedError(
        "connector.operation_conflict",
        "Connector authorization changed while accounts were discovered."
      )
    }
    return initialized
  }

  async completeReauthorization(
    input: CompleteConnectorReauthorizationInput
  ): Promise<ConnectorAuthorizationRecord> {
    this.assertRegistered(input.definition)
    return this.mutations.runLocallySerialized(input.authorizationId, () =>
      this.completeReauthorizationMutation(input)
    )
  }

  async revokeAuthorization(
    input: RevokeConnectorAuthorizationInput
  ): Promise<ConnectorAuthorizationRevocation> {
    this.assertRegistered(input.definition)
    return this.mutations.runLocallySerialized(input.authorizationId, async () => {
      const authorization = await this.requireAuthorization(
        input.definition.id,
        input.authorizationId
      )
      assertConnectorAuthorizationActor(authorization, input.principal)
      return this.revokeAuthorizationRecord(input.definition, authorization)
    })
  }

  /** Continues cleanup only after storage has already fenced the authorization from new usage. */
  async continuePendingRevocation(
    definition: OAuthConnectorDefinition,
    authorizationId: string
  ): Promise<ConnectorAuthorizationRevocation> {
    this.assertRegistered(definition)
    return this.mutations.runLocallySerialized(authorizationId, async () => {
      const authorization = await this.requireAuthorization(definition.id, authorizationId)
      if (authorization.status !== "revocation_pending" && authorization.status !== "revoked") {
        throw createConnectorCodedError(
          "internal.unexpected",
          "Connector cleanup requires an authorization already pending revocation."
        )
      }
      return this.revokeAuthorizationRecord(definition, authorization)
    })
  }

  async requireStableActiveAuthorization(
    definition: OAuthConnectorDefinition,
    authorizationId: string
  ): Promise<ConnectorAuthorizationRecord> {
    this.assertRegistered(definition)
    return this.tokens.requireStableActiveAuthorization(definition, authorizationId)
  }

  createTokenSource(
    definition: OAuthConnectorDefinition,
    authorizationId: string
  ): ConnectorTokenSource {
    this.assertRegistered(definition)
    return this.tokens.createTokenSource(definition, authorizationId)
  }

  async requireAuthorization(
    connectorId: string,
    authorizationId: string
  ): Promise<ConnectorAuthorizationRecord> {
    const authorization = await withConnectorStorageBoundary(
      "Connector authorization could not be read.",
      () =>
        this.storage.getAuthorization({
          projectId: this.projectId,
          connectorId,
          authorizationId,
        })
    )
    if (!authorization) {
      throw createConnectorCodedError(
        "connector.not_found",
        "Connector authorization was not found."
      )
    }
    return authorization
  }

  private async revokeAuthorizationRecord(
    definition: OAuthConnectorDefinition,
    initial: ConnectorAuthorizationRecord
  ): Promise<ConnectorAuthorizationRevocation> {
    if (initial.status === "revoked") return { disconnected: [] }

    const authorization = await this.mutations.prepareAuthorizationForMutation(
      definition.id,
      initial,
      "revocation"
    )
    if (authorization.status === "revoked") return { disconnected: [] }

    const claimOutcome = await this.mutations.claimCredentialMutation(
      definition.id,
      authorization,
      "revocation"
    )
    if (claimOutcome.type === "superseded") return { disconnected: [] }
    const { claim } = claimOutcome

    let credentials: ConnectorOAuthCredentials | undefined
    if (definition.adapter.authentication.revoke) {
      try {
        if (!claim.authorization.credentials) {
          throw createConnectorCodedError(
            "connector.credentials_unavailable",
            "Stored connector credentials are unavailable."
          )
        }
        credentials = await this.credentials.open(
          definition.id,
          claim.authorization.id,
          claim.authorization.credentials
        )
      } catch (error) {
        await recoverConnectorFailure(
          error,
          "Connector credential mutation could not be released after credential decryption failed.",
          () => this.mutations.releaseCredentialMutation(claim.authorization)
        )
        throw createConnectorCodedError(
          "connector.credentials_unavailable",
          "Connector revocation is pending, but stored credentials could not be opened.",
          { cause: error }
        )
      }
    }

    try {
      await this.mutations.executeCredentialMutation(
        claim.authorization,
        async (executing, signal) => {
          if (definition.adapter.authentication.revoke && credentials) {
            await definition.adapter.authentication.revoke(
              this.adapterContext(definition.id, signal),
              credentials
            )
          }
          return this.mutations.stageCredentialMutationRevocation(executing, signal)
        }
      )
    } catch (error) {
      const latest = await recoverConnectorFailure(
        error,
        "Connector revocation outcome could not be recovered from storage.",
        () => this.requireAuthorization(definition.id, authorization.id)
      )
      if (this.mutations.isStagedMutation(latest, claim.authorization, "revocation")) {
        await recoverConnectorFailure(
          error,
          "Staged connector revocation could not be finalized during recovery.",
          () => this.mutations.finalizeStagedMutation(latest)
        )
        return { disconnected: claim.disconnected }
      }
      await recoverConnectorFailure(
        error,
        "Connector revocation mutation could not be released for retry.",
        () => this.mutations.releaseCredentialMutation(claim.authorization)
      )
      throw createConnectorCodedError(
        "connector.revocation_pending",
        "Connector revocation is pending; provider revocation can be retried safely.",
        { cause: error }
      )
    }

    const staged = await this.requireAuthorization(definition.id, authorization.id)
    await this.mutations.finalizeStagedMutation(staged)
    return { disconnected: claim.disconnected }
  }

  private async revokeAbandonedAuthorization(
    definition: OAuthConnectorDefinition,
    authorizationId: string,
    principal: AuthorizablePrincipal,
    primaryError: unknown
  ): Promise<void> {
    try {
      await this.revokeAuthorization({ definition, authorizationId, principal })
    } catch (cleanupError) {
      if (isSixbError(cleanupError) && cleanupError.code === "connector.revocation_pending") return
      throw createConnectorCodedError(
        "internal.unexpected",
        "Unused connector credentials could not be scheduled for revocation.",
        {
          cause: new AggregateError(
            [primaryError, cleanupError],
            "Connector authorization failed and cleanup could not be secured."
          ),
        }
      )
    }
  }

  private async completeReauthorizationMutation(
    input: CompleteConnectorReauthorizationInput
  ): Promise<ConnectorAuthorizationRecord> {
    let authorization = await this.requireAuthorization(input.definition.id, input.authorizationId)
    assertReauthorizationRevision(authorization, input.expectedRevision)
    if (authorization.status === "revoked" || authorization.status === "revocation_pending") {
      throw createConnectorCodedError(
        "connector.authorization_invalid",
        "Revoked connector credentials cannot be reauthorized."
      )
    }
    assertConnectorAuthorizationActor(authorization, input.principal)
    await this.mutations.assertAttachedConnections(
      input.definition.id,
      authorization.id,
      input.expectedConnectionIds
    )
    authorization = await this.mutations.prepareAuthorizationForMutation(
      input.definition.id,
      authorization,
      "reauthorization"
    )
    assertReauthorizationRevision(authorization, input.expectedRevision)
    await this.mutations.assertAttachedConnections(
      input.definition.id,
      authorization.id,
      input.expectedConnectionIds
    )
    const claimOutcome = await this.mutations.claimCredentialMutation(
      input.definition.id,
      authorization,
      "reauthorization",
      input.expectedConnectionIds
    )
    if (claimOutcome.type === "superseded") {
      throw createConnectorCodedError(
        "internal.unexpected",
        "Connector reauthorization was superseded unexpectedly."
      )
    }
    const { claim } = claimOutcome

    try {
      await this.mutations.executeCredentialMutation(
        claim.authorization,
        async (executing, signal) => {
          const credentials = validateCredentials(
            await input.definition.adapter.authentication.exchangeCode(
              this.authorizationAdapterContext(input.definition.id, input.redirectUri, signal),
              { code: input.code, codeVerifier: input.codeVerifier }
            )
          )
          assertCredentialMutationOperationActive(signal)
          const envelope = await this.credentials.seal(
            input.definition.id,
            input.authorizationId,
            credentials
          )
          return this.mutations.stageCredentialMutationCredentials(executing, signal, {
            credentials: envelope,
            ...(credentials.expiresAt === undefined
              ? {}
              : { credentialExpiresAt: credentials.expiresAt }),
            scopes: credentials.scopes ?? [],
          })
        }
      )
    } catch (error) {
      const latest = await recoverConnectorFailure(
        error,
        "Connector reauthorization outcome could not be recovered from storage.",
        () => this.requireAuthorization(input.definition.id, input.authorizationId)
      )
      if (this.mutations.isStagedMutation(latest, claim.authorization, "reauthorization")) {
        return recoverConnectorFailure(
          error,
          "Staged connector reauthorization could not be finalized during recovery.",
          () => this.mutations.finalizeStagedMutation(latest)
        )
      }
      if (oauthErrorKind(error) === "retryable" || oauthErrorKind(error) === "terminal") {
        await recoverConnectorFailure(
          error,
          "Connector reauthorization mutation could not be released after provider failure.",
          () => this.mutations.releaseCredentialMutation(claim.authorization)
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
        () => this.mutations.markNeedsReauthorization(claim.authorization)
      )
      throw createConnectorCodedError(
        "connector.authorization_required",
        "Connector authorization code exchange had an ambiguous outcome; reauthorization is required.",
        { cause: error }
      )
    }

    const staged = await this.requireAuthorization(input.definition.id, input.authorizationId)
    return this.mutations.finalizeStagedMutation(staged)
  }

  private async exchangeAuthorizationCode(
    definition: OAuthConnectorDefinition,
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<ConnectorOAuthCredentials> {
    try {
      return validateCredentials(
        await this.mutations.withBoundedProviderSignal((signal) =>
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

  private async discoverAccounts(
    definition: OAuthConnectorDefinition,
    credentials: ConnectorOAuthCredentials
  ): Promise<readonly ConnectorAccountCandidate[]> {
    return validateAccounts(
      await this.mutations.withBoundedProviderSignal(
        (signal) =>
          definition.adapter.discoverAccounts(
            this.adapterContext(definition.id, signal),
            credentials
          ),
        () =>
          createConnectorCodedError(
            "connector.provider_failed",
            "Connector account discovery did not complete."
          )
      )
    )
  }

  private adapterContext(connectorId: string, signal: AbortSignal) {
    return { projectId: this.projectId, connectorId, signal }
  }

  private authorizationAdapterContext(
    connectorId: string,
    redirectUri: string,
    signal: AbortSignal
  ) {
    return { ...this.adapterContext(connectorId, signal), redirectUri }
  }

  private definitionFor(connectorId: string): OAuthConnectorDefinition {
    const definition = this.resolveDefinition(connectorId)
    if (definition.id !== connectorId) {
      throw createConnectorCodedError(
        "internal.unexpected",
        "Connector definition resolver returned a mismatched definition."
      )
    }
    return definition
  }

  private assertRegistered(definition: OAuthConnectorDefinition): void {
    if (this.definitionFor(definition.id) !== definition) {
      throw createConnectorCodedError(
        "connector.configuration_invalid",
        `Connector '${definition.id}' is not the registered definition instance.`
      )
    }
  }
}

export function assertConnectorAuthorizationActor(
  authorization: ConnectorAuthorizationRecord,
  principal: AuthorizablePrincipal
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

function assertReauthorizationRevision(
  authorization: ConnectorAuthorizationRecord,
  expectedRevision: number
): void {
  if (authorization.revision !== expectedRevision) {
    throw createConnectorCodedError(
      "connector.authorization_invalid",
      "Connector reauthorization attempt is stale; restart authorization."
    )
  }
}
