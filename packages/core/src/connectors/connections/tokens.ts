import type { ConnectorAuthorizationRecord, ConnectorConnectionStorage } from "../../storage"
import { createConnectorCodedError, oauthErrorKind, recoverConnectorFailure } from "../errors"
import type {
  ConnectorAccessToken,
  ConnectorDefinition,
  ConnectorOAuthCredentials,
  ConnectorTokenSource,
  OAuthConnectorAdapter,
} from "../types"
import type { ConnectorCredentialCodec } from "./credential-codec"
import {
  assertCredentialMutationOperationActive,
  type ConnectorCredentialMutationCoordinator,
  connectorAuthorizationStatusError,
} from "./credential-mutations"
import { withConnectorStorageBoundary } from "./storage-boundary"
import { nonNegativeDuration, shouldRefresh, tokenView, validateCredentials } from "./validation"

type OAuthConnectorDefinition = ConnectorDefinition<string, OAuthConnectorAdapter>

export interface ConnectorTokenAccessOptions {
  readonly projectId: string
  readonly storage: ConnectorConnectionStorage
  readonly credentials: ConnectorCredentialCodec
  readonly mutations: ConnectorCredentialMutationCoordinator
  readonly refreshSkewMs: number
  readonly now: () => Date
}

/** Owns revision-aware access-token delivery and refresh. */
export class ConnectorTokenAccess {
  private readonly projectId: string
  private readonly storage: ConnectorConnectionStorage
  private readonly credentials: ConnectorCredentialCodec
  private readonly mutations: ConnectorCredentialMutationCoordinator
  private readonly refreshSkewMs: number
  private readonly now: () => Date

  constructor(options: ConnectorTokenAccessOptions) {
    this.projectId = options.projectId
    this.storage = options.storage
    this.credentials = options.credentials
    this.mutations = options.mutations
    this.refreshSkewMs = nonNegativeDuration(options.refreshSkewMs, "refresh skew")
    this.now = options.now
  }

  requireStableActiveAuthorization(
    definition: OAuthConnectorDefinition,
    authorizationId: string
  ): Promise<ConnectorAuthorizationRecord> {
    return this.mutations.requireStableActiveAuthorization(definition.id, authorizationId)
  }

  createTokenSource(
    definition: OAuthConnectorDefinition,
    authorizationId: string
  ): ConnectorTokenSource {
    return new RevisionAwareConnectorTokenSource((rejectedRevision) =>
      this.getAccessToken(definition, authorizationId, rejectedRevision)
    )
  }

  private open(
    connectorId: string,
    authorization: ConnectorAuthorizationRecord
  ): Promise<ConnectorOAuthCredentials> {
    if (!authorization.credentials) {
      throw createConnectorCodedError(
        "connector.credentials_unavailable",
        "Stored connector credentials are unavailable."
      )
    }
    return this.credentials.open(connectorId, authorization.id, authorization.credentials)
  }

  private async getAccessToken(
    definition: OAuthConnectorDefinition,
    authorizationId: string,
    rejectedRevision?: number
  ): Promise<{
    readonly token: { readonly accessToken: string; readonly tokenType?: string }
    readonly revision: number
  }> {
    let authorization = await this.mutations.requireStableActiveAuthorization(
      definition.id,
      authorizationId
    )
    const credentials = await this.open(definition.id, authorization)
    const refreshRejectedToken =
      rejectedRevision !== undefined && rejectedRevision === authorization.revision
    if (refreshRejectedToken || shouldRefresh(authorization, this.now(), this.refreshSkewMs)) {
      authorization = await this.refreshAuthorization(definition, authorization)
      const refreshed = await this.open(definition.id, authorization)
      return { token: tokenView(refreshed), revision: authorization.revision }
    }
    return { token: tokenView(credentials), revision: authorization.revision }
  }

  private async refreshAuthorization(
    definition: OAuthConnectorDefinition,
    initial: ConnectorAuthorizationRecord
  ): Promise<ConnectorAuthorizationRecord> {
    return this.mutations.runLocallySerialized(initial.id, async () => {
      let authorization = await this.mutations.requireStableActiveAuthorization(
        definition.id,
        initial.id
      )
      if (authorization.revision !== initial.revision) return authorization
      authorization = await this.mutations.prepareAuthorizationForMutation(
        definition.id,
        authorization,
        "refresh"
      )
      if (authorization.revision !== initial.revision) return authorization
      const claimOutcome = await this.mutations.claimCredentialMutation(
        definition.id,
        authorization,
        "refresh"
      )
      if (claimOutcome.type === "superseded") return claimOutcome.authorization
      const { claim } = claimOutcome

      let current: ConnectorOAuthCredentials
      try {
        current = await this.open(definition.id, claim.authorization)
      } catch (error) {
        await recoverConnectorFailure(
          error,
          "Connector credential mutation could not be released after credential decryption failed.",
          () => this.mutations.releaseCredentialMutation(claim.authorization)
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
          () => this.mutations.markNeedsReauthorization(claim.authorization)
        )
        throw error
      }

      try {
        await this.mutations.executeCredentialMutation(
          claim.authorization,
          async (executing, signal) => {
            const refreshed = validateCredentials(
              await definition.adapter.authentication.refresh(
                this.adapterContext(definition.id, signal),
                current
              )
            )
            assertCredentialMutationOperationActive(signal)
            const normalized = {
              ...refreshed,
              ...(refreshed.refreshToken === undefined
                ? { refreshToken: current.refreshToken }
                : {}),
              ...(refreshed.tokenType === undefined && current.tokenType !== undefined
                ? { tokenType: current.tokenType }
                : {}),
              scopes: refreshed.scopes ?? current.scopes ?? authorization.scopes,
            } satisfies ConnectorOAuthCredentials
            const envelope = await this.credentials.seal(
              definition.id,
              authorization.id,
              normalized
            )
            return this.mutations.stageCredentialMutationCredentials(executing, signal, {
              credentials: envelope,
              ...(normalized.expiresAt === undefined
                ? {}
                : { credentialExpiresAt: normalized.expiresAt }),
              scopes: normalized.scopes,
            })
          }
        )
      } catch (error) {
        const latest = await recoverConnectorFailure(
          error,
          "Connector refresh outcome could not be recovered from storage.",
          () => this.requireAuthorization(definition.id, authorization.id)
        )
        if (this.mutations.isStagedMutation(latest, claim.authorization, "refresh")) {
          return recoverConnectorFailure(
            error,
            "Staged connector refresh could not be finalized during recovery.",
            () => this.mutations.finalizeStagedMutation(latest)
          )
        }
        if (oauthErrorKind(error) === "retryable") {
          await recoverConnectorFailure(
            error,
            "Connector refresh mutation could not be released after a retryable provider failure.",
            () => this.mutations.releaseCredentialMutation(claim.authorization)
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
          () => this.mutations.markNeedsReauthorization(claim.authorization)
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
        throw connectorAuthorizationStatusError(recovered.status)
      }

      const staged = await this.requireAuthorization(definition.id, authorization.id)
      return this.mutations.finalizeStagedMutation(staged)
    })
  }

  private async requireAuthorization(
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

  private adapterContext(connectorId: string, signal: AbortSignal) {
    return { projectId: this.projectId, connectorId, signal }
  }
}

class RevisionAwareConnectorTokenSource implements ConnectorTokenSource {
  private rejectedRevision: number | undefined

  constructor(
    private readonly resolveToken: (rejectedRevision?: number) => Promise<{
      readonly token: { readonly accessToken: string; readonly tokenType?: string }
      readonly revision: number
    }>
  ) {}

  async get(): Promise<ConnectorAccessToken> {
    const consumedRejection = this.rejectedRevision
    const result = await this.resolveToken(consumedRejection)
    if (this.rejectedRevision === consumedRejection) this.rejectedRevision = undefined

    let invalidated = false
    return Object.freeze({
      ...result.token,
      invalidate: () => {
        if (invalidated) return
        invalidated = true
        this.rejectedRevision = Math.max(this.rejectedRevision ?? -1, result.revision)
      },
    })
  }
}
