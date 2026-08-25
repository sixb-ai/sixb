import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { AuthorizablePrincipal } from "../../execution"
import { ensureExecutionRecord } from "../../execution/durable"
import type {
  ConnectorAuthorizationAttemptRecord,
  ConnectorAuthorizationRecord,
  ConnectorConnectionRecord,
  ConnectorConnectionStorage,
  CreateConnectorAuthorizationAttemptInput,
  Storage,
} from "../../storage"
import type { ConnectorCredentialProtector } from "../credentials"
import {
  createConnectorCodedError,
  isConnectorStorageError,
  providerBoundaryError,
  providerFailureCode,
  storageBoundaryError,
} from "../errors"
import type { ConnectorDefinition, OAuthConnectorAdapter } from "../types"
import {
  assertConnectorAuthorizationAttemptInitiator,
  type ConnectorConnectionCommandActor,
  requireConnectorConnectionCommandActor,
} from "./command-context"
import type {
  CompleteConnectorAuthorizationInput,
  CompleteConnectorAuthorizationResult,
  ConnectorConnectionCommandContext,
  ConnectorConnectionView,
  StartConnectorAuthorizationInput,
  StartConnectorAuthorizationResult,
} from "./contracts"
import { runBoundedConnectorProviderOperation } from "./provider-operation"
import {
  assertAuthorizationUrlParameters,
  hashSecret,
  nonblank,
  normalizedHttpUrl,
  parseAttemptId,
  positiveDuration,
} from "./validation"
import { assertConnectorConnectionSelector, connectorConnectionView } from "./views"

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

type OAuthConnectorDefinition = ConnectorDefinition<string, OAuthConnectorAdapter>

export type ResolveOAuthConnectorDefinition = (connectorId: string) => OAuthConnectorDefinition

export interface PrepareConnectorReauthorizationInput {
  readonly definition: OAuthConnectorDefinition
  readonly authorizationId: string
  readonly principal: AuthorizablePrincipal
}

export interface PreparedConnectorReauthorization {
  readonly authorization: ConnectorAuthorizationRecord
  readonly connections: readonly ConnectorConnectionRecord[]
}

export interface CompleteNewConnectorAuthorizationInput {
  readonly definition: OAuthConnectorDefinition
  readonly principal: AuthorizablePrincipal
  readonly code: string
  readonly codeVerifier: string
  readonly redirectUri: string
  /** Called immediately after the encrypted grant is durable, before account discovery. */
  readonly onAuthorizationPersisted?: (authorization: ConnectorAuthorizationRecord) => Promise<void>
}

export interface CompleteConnectorReauthorizationInput
  extends CompleteNewConnectorAuthorizationInput {
  readonly authorizationId: string
  readonly expectedRevision: number
  readonly expectedConnectionIds: readonly string[]
}

/** Grant lifecycle required after an OAuth request has proved its state and initiating actor. */
export interface ConnectorAuthorizationLifecycle {
  prepareReauthorization(
    input: PrepareConnectorReauthorizationInput
  ): Promise<PreparedConnectorReauthorization>
  completeNewAuthorization(
    input: CompleteNewConnectorAuthorizationInput
  ): Promise<ConnectorAuthorizationRecord>
  completeReauthorization(
    input: CompleteConnectorReauthorizationInput
  ): Promise<ConnectorAuthorizationRecord>
}

export interface ConnectorAuthorizationRequestHandlerOptions {
  readonly projectId: string
  readonly storage: Storage
  readonly credentialProtector: ConnectorCredentialProtector
  readonly authorizationAttemptTtlMs: number
  readonly providerOperationTimeoutMs: number
  readonly resolveDefinition: ResolveOAuthConnectorDefinition
  readonly lifecycle: ConnectorAuthorizationLifecycle
  /** Returns the current host signal; the host may replace its controller after closing. */
  readonly hostSignal: () => AbortSignal
}

export interface PreparedConnectorAuthorizationRequest {
  readonly definition: OAuthConnectorDefinition
  readonly actor: ConnectorConnectionCommandActor
  readonly state: string
  readonly authorizationUrl: string
  readonly attempt: CreateConnectorAuthorizationAttemptInput
  readonly affectedConnections: readonly ConnectorConnectionView[]
}

/** Owns OAuth request state, PKCE, callback binding, and durable attempt provenance. */
export class ConnectorAuthorizationRequestHandler {
  private readonly projectId: string
  private readonly storage: Storage
  private readonly credentialProtector: ConnectorCredentialProtector
  private readonly authorizationAttemptTtlMs: number
  private readonly providerOperationTimeoutMs: number
  private readonly resolveDefinition: ResolveOAuthConnectorDefinition
  private readonly lifecycle: ConnectorAuthorizationLifecycle
  private readonly hostSignal: () => AbortSignal

  constructor(options: ConnectorAuthorizationRequestHandlerOptions) {
    this.projectId = options.projectId
    this.storage = options.storage
    this.credentialProtector = options.credentialProtector
    this.authorizationAttemptTtlMs = positiveDuration(
      options.authorizationAttemptTtlMs,
      "authorization attempt TTL"
    )
    this.providerOperationTimeoutMs = positiveDuration(
      options.providerOperationTimeoutMs,
      "provider operation timeout"
    )
    this.resolveDefinition = options.resolveDefinition
    this.lifecycle = options.lifecycle
    this.hostSignal = options.hostSignal
  }

  async startAuthorization(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    input: StartConnectorAuthorizationInput
  ): Promise<StartConnectorAuthorizationResult> {
    const prepared = await this.prepareAuthorizationRequest(command, connectorId, input)

    try {
      await this.storage.transaction(
        async (tx) => {
          await ensureExecutionRecord(tx.executions, command.execution)
          await requireConnectorConnectionStorage(tx).createAuthorizationAttempt(prepared.attempt)
        },
        { isolation: "serializable" }
      )
    } catch (error) {
      throw storageBoundaryError(error, "Connector authorization attempt could not be persisted.")
    }

    return {
      authorizationUrl: prepared.authorizationUrl,
      affectedConnections: prepared.affectedConnections,
    }
  }

  async prepareAuthorizationRequest(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    input: StartConnectorAuthorizationInput
  ): Promise<PreparedConnectorAuthorizationRequest> {
    const definition = this.resolveDefinition(nonblank(connectorId, "connector id"))
    const actor = requireConnectorConnectionCommandActor(command.execution, this.projectId)
    assertConnectorConnectionSelector(input)
    const redirectUri = normalizedHttpUrl(input.redirectUri, "OAuth callback URL")
    const reauthorization = await this.prepareReauthorization(
      definition,
      actor,
      input.reauthorizationId
    )

    const attemptId = `cat_${randomUUID()}`
    const state = `${attemptId}.${randomBytes(32).toString("base64url")}`
    const codeVerifier = randomBytes(32).toString("base64url")
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
    let authorizationUrlInput: string | URL
    try {
      authorizationUrlInput = await runBoundedConnectorProviderOperation(
        {
          hostSignal: this.hostSignal(),
          timeoutMs: this.providerOperationTimeoutMs,
        },
        (signal) =>
          definition.adapter.authentication.authorizationUrl(
            {
              projectId: this.projectId,
              connectorId: definition.id,
              redirectUri,
              signal,
            },
            { state, codeChallenge, codeChallengeMethod: "S256" }
          ),
        () =>
          createConnectorCodedError(
            "connector.provider_unavailable",
            "Connector authorization URL generation did not complete."
          )
      )
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
    const codeVerifierEnvelope = await this.credentialProtector.seal(
      textEncoder.encode(codeVerifier),
      {
        projectId: this.projectId,
        connectorId: definition.id,
        recordId: attemptId,
        purpose: "pkce-verifier",
      }
    )

    return {
      definition,
      actor,
      state,
      authorizationUrl,
      attempt: {
        id: attemptId,
        projectId: this.projectId,
        connectorId: definition.id,
        owner: input.owner,
        slot: input.slot,
        initiatedByExecutionId: command.execution.id,
        stateHash: hashSecret(state),
        codeVerifier: codeVerifierEnvelope,
        redirectUri,
        ...(reauthorization === undefined
          ? {}
          : {
              reauthorizationId: reauthorization.authorization.id,
              reauthorizationRevision: reauthorization.authorization.revision,
              reauthorizationConnectionIds: reauthorization.connectionIds,
            }),
        ttlMs: this.authorizationAttemptTtlMs,
      },
      affectedConnections: reauthorization?.affectedConnections ?? [],
    }
  }

  async completeAuthorization(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    input: CompleteConnectorAuthorizationInput
  ): Promise<CompleteConnectorAuthorizationResult> {
    const definition = this.resolveDefinition(nonblank(connectorId, "connector id"))
    const actor = requireConnectorConnectionCommandActor(command.execution, this.projectId)
    const state = nonblank(input.state, "OAuth state", "connector.authorization_invalid")
    const code = nonblank(input.code, "OAuth authorization code", "connector.authorization_invalid")
    const redirectUri = normalizedHttpUrl(input.redirectUri, "OAuth callback URL")
    const attempt = await this.consumeAuthorizationAttempt(definition.id, actor, state, redirectUri)
    const completed = await this.completeAuthorizationAttempt({
      definition,
      attempt,
      principal: actor.principal,
      code,
      redirectUri,
    })

    return {
      authorizationId: completed.id,
      owner: attempt.owner,
      slot: attempt.slot,
      accounts: completed.accounts,
    }
  }

  async completeAuthorizationAttempt(input: {
    readonly definition: OAuthConnectorDefinition
    readonly attempt: ConnectorAuthorizationAttemptRecord
    readonly principal: AuthorizablePrincipal
    readonly code: string
    readonly redirectUri: string
    readonly onAuthorizationPersisted?: (
      authorization: ConnectorAuthorizationRecord
    ) => Promise<void>
  }): Promise<ConnectorAuthorizationRecord> {
    const verifierBytes = await this.credentialProtector.open(input.attempt.codeVerifier, {
      projectId: this.projectId,
      connectorId: input.definition.id,
      recordId: input.attempt.id,
      purpose: "pkce-verifier",
    })
    return this.completeGrant({
      ...input,
      codeVerifier: textDecoder.decode(verifierBytes),
    })
  }

  private async prepareReauthorization(
    definition: OAuthConnectorDefinition,
    actor: ConnectorConnectionCommandActor,
    reauthorizationId: string | undefined
  ): Promise<
    | {
        readonly authorization: ConnectorAuthorizationRecord
        readonly connectionIds: readonly string[]
        readonly affectedConnections: readonly ConnectorConnectionView[]
      }
    | undefined
  > {
    if (reauthorizationId === undefined) return undefined

    const prepared = await this.lifecycle.prepareReauthorization({
      definition,
      authorizationId: nonblank(reauthorizationId, "reauthorization id"),
      principal: actor.principal,
    })
    const connectionIds = prepared.connections.map((connection) => connection.id).sort()
    return {
      authorization: prepared.authorization,
      connectionIds,
      affectedConnections: prepared.connections.map((connection) =>
        connectorConnectionView(connection, prepared.authorization.status)
      ),
    }
  }

  private async consumeAuthorizationAttempt(
    connectorId: string,
    actor: ConnectorConnectionCommandActor,
    state: string,
    redirectUri: string
  ): Promise<ConnectorAuthorizationAttemptRecord> {
    const attemptId = parseAttemptId(state)
    let outcome:
      | { readonly type: "consumed"; readonly attempt: ConnectorAuthorizationAttemptRecord }
      | { readonly type: "invalid"; readonly cause: unknown }
    try {
      outcome = await this.storage.transaction(
        async (tx) => {
          let attempt: ConnectorAuthorizationAttemptRecord
          try {
            attempt = await requireConnectorConnectionStorage(tx).consumeAuthorizationAttempt({
              id: attemptId,
              projectId: this.projectId,
              connectorId,
              stateHash: hashSecret(state),
              redirectUri,
            })
          } catch (error) {
            if (isConnectorStorageError(error, "attempt_invalid")) {
              return { type: "invalid", cause: error } as const
            }
            throw error
          }
          const initiator = await tx.executions.getById({
            projectId: this.projectId,
            id: attempt.initiatedByExecutionId,
          })
          assertConnectorAuthorizationAttemptInitiator(initiator, actor)
          return { type: "consumed", attempt } as const
        },
        { isolation: "serializable" }
      )
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

    if (outcome.type === "invalid") {
      throw createConnectorCodedError(
        "connector.authorization_invalid",
        "Connector authorization attempt is invalid, expired, or already used.",
        { cause: outcome.cause }
      )
    }
    return outcome.attempt
  }

  private completeGrant(input: {
    readonly definition: OAuthConnectorDefinition
    readonly attempt: ConnectorAuthorizationAttemptRecord
    readonly principal: AuthorizablePrincipal
    readonly code: string
    readonly codeVerifier: string
    readonly redirectUri: string
    readonly onAuthorizationPersisted?: (
      authorization: ConnectorAuthorizationRecord
    ) => Promise<void>
  }): Promise<ConnectorAuthorizationRecord> {
    if (input.attempt.reauthorizationId === undefined) {
      return this.lifecycle.completeNewAuthorization({
        definition: input.definition,
        principal: input.principal,
        code: input.code,
        codeVerifier: input.codeVerifier,
        redirectUri: input.redirectUri,
        ...(input.onAuthorizationPersisted === undefined
          ? {}
          : { onAuthorizationPersisted: input.onAuthorizationPersisted }),
      })
    }

    const expectedRevision = input.attempt.reauthorizationRevision
    if (expectedRevision === undefined) {
      throw createConnectorCodedError(
        "internal.unexpected",
        "Connector reauthorization attempt is missing its revision."
      )
    }
    return this.lifecycle.completeReauthorization({
      definition: input.definition,
      authorizationId: input.attempt.reauthorizationId,
      expectedRevision,
      expectedConnectionIds: input.attempt.reauthorizationConnectionIds ?? [],
      principal: input.principal,
      code: input.code,
      codeVerifier: input.codeVerifier,
      redirectUri: input.redirectUri,
    })
  }
}

function requireConnectorConnectionStorage(storage: Storage): ConnectorConnectionStorage {
  if (storage.connectorConnections) return storage.connectorConnections
  throw createConnectorCodedError(
    "internal.unexpected",
    "Connector connection storage is unavailable inside the storage transaction."
  )
}
