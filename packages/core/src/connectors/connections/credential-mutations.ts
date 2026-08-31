import { randomUUID } from "node:crypto"
import type {
  ClaimConnectorCredentialMutationResult,
  ConnectorAuthorizationRecord,
  ConnectorConnectionStorage,
  ConnectorCredentialMutationKind,
  ConnectorStagedCredentials,
} from "../../storage"
import type { SealedConnectorCredential } from "../credentials"
import {
  createAmbiguousProviderOperationError,
  createConnectorCodedError,
  isConnectorStorageError,
  providerBoundaryError,
  recoverConnectorFailure,
  storageBoundaryError,
} from "../errors"
import type { ConnectorAccountCandidate } from "../types"
import { runBoundedConnectorProviderOperation } from "./provider-operation"
import { withConnectorStorageBoundary } from "./storage-boundary"
import { delay, positiveDuration, sameIds } from "./validation"

const MUTATION_POLL_MS = 25
const MUTATION_WAIT_MS = 5_000

export type ConnectorCredentialMutationClaimOutcome =
  | {
      readonly type: "claimed"
      readonly claim: ClaimConnectorCredentialMutationResult
    }
  | {
      readonly type: "superseded"
      readonly authorization: ConnectorAuthorizationRecord
    }

export interface ConnectorCredentialMutationCoordinatorOptions {
  readonly projectId: string
  readonly storage: ConnectorConnectionStorage
  readonly leaseDurationMs: number
  readonly operationTimeoutMs: number
  /** Returns the current host signal; the host may replace its controller after closing. */
  readonly hostSignal: () => AbortSignal
  readonly discoverReauthorizationAccounts: (
    authorization: ConnectorAuthorizationRecord,
    staged: ConnectorStagedCredentials
  ) => Promise<readonly ConnectorAccountCandidate[]>
  /** Injectable for deterministic tests. A unique value is generated in normal operation. */
  readonly holderId?: string
}

export interface StageConnectorCredentialMutationInput {
  readonly credentials: SealedConnectorCredential
  readonly credentialExpiresAt?: Date
  readonly scopes: readonly string[]
}

/**
 * Coordinates every provider-side OAuth credential mutation.
 *
 * Storage owns the durable fence and deadline. This coordinator owns process-local serialization,
 * lease renewal, provider deadlines, ambiguous-outcome handling, and staged-result finalization.
 */
export class ConnectorCredentialMutationCoordinator {
  private readonly projectId: string
  private readonly storage: ConnectorConnectionStorage
  private readonly leaseDurationMs: number
  private readonly operationTimeoutMs: number
  private readonly hostSignal: () => AbortSignal
  private readonly discoverReauthorizationAccounts: (
    authorization: ConnectorAuthorizationRecord,
    staged: ConnectorStagedCredentials
  ) => Promise<readonly ConnectorAccountCandidate[]>
  private readonly holderId: string
  private readonly localMutationTails = new Map<string, Promise<void>>()

  constructor(options: ConnectorCredentialMutationCoordinatorOptions) {
    this.projectId = options.projectId
    this.storage = options.storage
    this.leaseDurationMs = positiveDuration(
      options.leaseDurationMs,
      "credential mutation lease duration"
    )
    this.operationTimeoutMs = positiveDuration(
      options.operationTimeoutMs,
      "credential mutation timeout"
    )
    this.hostSignal = options.hostSignal
    this.discoverReauthorizationAccounts = options.discoverReauthorizationAccounts
    this.holderId = options.holderId ?? `connector-service-${randomUUID()}`
  }

  async claimCredentialMutation(
    connectorId: string,
    initial: ConnectorAuthorizationRecord,
    kind: ConnectorCredentialMutationKind,
    expectedConnectionIds?: readonly string[]
  ): Promise<ConnectorCredentialMutationClaimOutcome> {
    const waitDeadline = Date.now() + MUTATION_WAIT_MS
    const initialRevision = initial.revision
    let authorization = initial

    while (true) {
      const claimed = await withConnectorStorageBoundary(
        "Connector credential mutation could not be claimed.",
        () =>
          this.storage.claimCredentialMutation({
            projectId: this.projectId,
            connectorId,
            authorizationId: authorization.id,
            expectedRevision: authorization.revision,
            mutation: { id: `ccm_${randomUUID()}`, kind, holderId: this.holderId },
            ...(expectedConnectionIds === undefined ? {} : { expectedConnectionIds }),
            leaseDurationMs: this.leaseDurationMs,
            operationTimeoutMs: this.operationTimeoutMs,
          })
      )
      if (claimed) return { type: "claimed", claim: claimed }

      await delay(MUTATION_POLL_MS)
      authorization = await this.prepareAuthorizationForMutation(connectorId, authorization, kind)
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
      if (kind === "reauthorization" && authorization.revision !== initialRevision) {
        throw staleReauthorizationError()
      }
      if (kind === "revocation" && authorization.status === "revoked") {
        return { type: "superseded", authorization }
      }
      if (kind === "refresh" && authorization.revision !== initialRevision) {
        if (authorization.status !== "active") {
          throw connectorAuthorizationStatusError(authorization.status)
        }
        return { type: "superseded", authorization }
      }
      if (kind === "reauthorization" && expectedConnectionIds) {
        await this.assertAttachedConnections(connectorId, authorization.id, expectedConnectionIds)
      }
      if (Date.now() >= waitDeadline) {
        throw createConnectorCodedError(
          "connector.operation_in_progress",
          "Connector credentials are being changed by another operation; retry shortly."
        )
      }
    }
  }

  async prepareAuthorizationForMutation(
    connectorId: string,
    initial: ConnectorAuthorizationRecord,
    requestedKind: ConnectorCredentialMutationKind
  ): Promise<ConnectorAuthorizationRecord> {
    const authorization = await this.requireAuthorization(connectorId, initial.id)
    const mutation = authorization.credentialMutation
    if (!mutation) return authorization

    if (mutation.phase === "result_staged") {
      if (requestedKind === "revocation" && mutation.kind !== "revocation") {
        const marked = await this.markNeedsReauthorization(authorization)
        return marked ?? this.requireAuthorization(connectorId, authorization.id)
      }
      return this.finalizeStagedMutation(authorization)
    }

    const recovered = await this.recoverExpiredCredentialMutation(connectorId, authorization.id)
    return recovered ?? authorization
  }

  async recoverExpiredCredentialMutation(
    connectorId: string,
    authorizationId: string
  ): Promise<ConnectorAuthorizationRecord | null> {
    return withConnectorStorageBoundary(
      "Expired connector credential mutation could not be recovered.",
      () =>
        this.storage.recoverExpiredCredentialMutation({
          projectId: this.projectId,
          connectorId,
          authorizationId,
        })
    )
  }

  async executeCredentialMutation<T>(
    authorization: ConnectorAuthorizationRecord,
    run: (executing: ConnectorAuthorizationRecord, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (!authorization.credentialMutation) {
      throw createConnectorCodedError(
        "internal.unexpected",
        "Connector credential mutation was not claimed."
      )
    }
    const executing = await withConnectorStorageBoundary(
      "Connector credential mutation could not be marked as executing.",
      () =>
        this.storage.markCredentialMutationExecuting({
          ...credentialMutationFence(authorization),
          holderId: this.holderId,
        })
    )
    if (!executing) throw createAmbiguousProviderOperationError()
    return this.withCredentialMutationSignal(executing, (signal) => run(executing, signal))
  }

  async stageCredentialMutationCredentials(
    executing: ConnectorAuthorizationRecord,
    signal: AbortSignal,
    input: StageConnectorCredentialMutationInput
  ): Promise<ConnectorAuthorizationRecord> {
    assertCredentialMutationOperationActive(signal)
    const staged = await withConnectorStorageBoundary(
      "Connector credential mutation result could not be staged.",
      () =>
        this.storage.stageCredentialMutationCredentials({
          ...credentialMutationFence(executing),
          holderId: this.holderId,
          credentials: input.credentials,
          ...(input.credentialExpiresAt === undefined
            ? {}
            : { credentialExpiresAt: input.credentialExpiresAt }),
          scopes: input.scopes,
        })
    )
    if (!staged) throw createAmbiguousProviderOperationError()
    return staged
  }

  async stageCredentialMutationRevocation(
    executing: ConnectorAuthorizationRecord,
    signal: AbortSignal
  ): Promise<ConnectorAuthorizationRecord> {
    assertCredentialMutationOperationActive(signal)
    const staged = await withConnectorStorageBoundary(
      "Connector revocation result could not be staged.",
      () =>
        this.storage.stageCredentialMutationRevocation({
          ...credentialMutationFence(executing),
          holderId: this.holderId,
        })
    )
    if (!staged) throw createAmbiguousProviderOperationError()
    return staged
  }

  async withBoundedProviderSignal<T>(
    run: (signal: AbortSignal) => Promise<T> | T,
    interruptionError: () => Error = createAmbiguousProviderOperationError
  ): Promise<T> {
    return runBoundedConnectorProviderOperation(
      { hostSignal: this.hostSignal(), timeoutMs: this.operationTimeoutMs },
      run,
      interruptionError
    )
  }

  async finalizeStagedMutation(
    authorization: ConnectorAuthorizationRecord
  ): Promise<ConnectorAuthorizationRecord> {
    const mutation = authorization.credentialMutation
    if (!mutation || mutation.phase !== "result_staged") return authorization

    const fence = credentialMutationFence(authorization)
    let finalized: ConnectorAuthorizationRecord | null
    if (mutation.kind === "refresh") {
      finalized = await withConnectorStorageBoundary(
        "Connector credential refresh could not be finalized.",
        () => this.storage.finalizeRefresh(fence)
      )
    } else if (mutation.kind === "revocation") {
      finalized = await withConnectorStorageBoundary(
        "Connector credential revocation could not be finalized.",
        () => this.storage.finalizeRevocation(fence)
      )
    } else {
      const staged = mutation.stagedCredentials
      if (!staged) {
        throw createConnectorCodedError(
          "internal.unexpected",
          "Staged connector credentials are missing."
        )
      }
      let accounts: readonly ConnectorAccountCandidate[]
      try {
        accounts = await this.discoverReauthorizationAccounts(authorization, staged)
      } catch (error) {
        throw providerBoundaryError(
          error,
          "connector.provider_failed",
          "Connector account discovery failed; reauthorization remains safely staged."
        )
      }
      try {
        finalized = await this.storage.finalizeReauthorization({
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
        throw storageBoundaryError(
          error,
          "Connector credential reauthorization could not be finalized."
        )
      }
    }
    if (finalized) return finalized

    const latest = await this.requireAuthorization(authorization.connectorId, authorization.id)
    if (latest.revision !== authorization.revision || !latest.credentialMutation) return latest
    throw createConnectorCodedError(
      "internal.unexpected",
      "Connector credential mutation could not be finalized safely."
    )
  }

  async markNeedsReauthorization(
    authorization: ConnectorAuthorizationRecord
  ): Promise<ConnectorAuthorizationRecord | null> {
    if (!authorization.credentialMutation) return null
    return withConnectorStorageBoundary(
      "Connector authorization could not be marked for reauthorization.",
      () => this.storage.markNeedsReauthorization(credentialMutationFence(authorization))
    )
  }

  async releaseCredentialMutation(authorization: ConnectorAuthorizationRecord): Promise<boolean> {
    if (!authorization.credentialMutation) return false
    return withConnectorStorageBoundary(
      "Connector credential mutation could not be released.",
      () =>
        this.storage.releaseCredentialMutation({
          ...credentialMutationFence(authorization),
          holderId: this.holderId,
        })
    )
  }

  async requireStableActiveAuthorization(
    connectorId: string,
    authorizationId: string
  ): Promise<ConnectorAuthorizationRecord> {
    const waitDeadline = Date.now() + MUTATION_WAIT_MS
    while (true) {
      let authorization = await this.requireAuthorization(connectorId, authorizationId)
      if (authorization.credentialMutation) {
        authorization = await this.prepareAuthorizationForMutation(
          connectorId,
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
      if (authorization.status !== "active") {
        throw connectorAuthorizationStatusError(authorization.status)
      }
      return authorization
    }
  }

  async assertAttachedConnections(
    connectorId: string,
    authorizationId: string,
    expectedConnectionIds: readonly string[]
  ): Promise<void> {
    const attachedIds = (
      await withConnectorStorageBoundary(
        "Connector authorization connections could not be read.",
        () =>
          this.storage.listConnectionsByAuthorization({
            projectId: this.projectId,
            connectorId,
            authorizationId,
          })
      )
    ).map((connection) => connection.id)
    if (!sameIds(attachedIds, expectedConnectionIds)) {
      throw createConnectorCodedError(
        "connector.operation_conflict",
        "Connections attached to this authorization changed; restart reauthorization."
      )
    }
  }

  async runLocallySerialized<T>(authorizationId: string, run: () => Promise<T>): Promise<T> {
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

  isStagedMutation(
    authorization: ConnectorAuthorizationRecord,
    claimed: ConnectorAuthorizationRecord,
    kind: ConnectorCredentialMutationKind
  ): boolean {
    const claimedMutation = claimed.credentialMutation
    return (
      claimedMutation !== undefined &&
      authorization.credentialMutation?.id === claimedMutation.id &&
      authorization.credentialMutation.kind === kind &&
      authorization.credentialMutation.phase === "result_staged"
    )
  }

  private async withCredentialMutationSignal<T>(
    authorization: ConnectorAuthorizationRecord,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController()
    const hostSignal = this.hostSignal()
    const abortFromHost = () => controller.abort(createAmbiguousProviderOperationError())
    if (hostSignal.aborted) abortFromHost()
    else hostSignal.addEventListener("abort", abortFromHost, { once: true })
    const timeout = setTimeout(
      () => controller.abort(createAmbiguousProviderOperationError()),
      this.operationTimeoutMs
    )
    const heartbeat = setInterval(
      () => {
        void this.storage
          .renewCredentialMutation({
            ...credentialMutationFence(authorization),
            holderId: this.holderId,
            leaseDurationMs: this.leaseDurationMs,
          })
          .then((renewed) => {
            if (!renewed) controller.abort(createAmbiguousProviderOperationError())
          })
          .catch((error) =>
            controller.abort(createAmbiguousProviderOperationError({ cause: error }))
          )
      },
      Math.max(5, Math.floor(this.leaseDurationMs / 3))
    )

    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAborted = () => reject(abortReason(controller.signal))
      if (controller.signal.aborted) rejectAborted()
      else controller.signal.addEventListener("abort", rejectAborted, { once: true })
    })
    const operation = Promise.resolve().then(() => {
      assertCredentialMutationOperationActive(controller.signal)
      return run(controller.signal)
    })
    operation.catch(() => {})
    try {
      return await Promise.race([operation, aborted])
    } finally {
      clearInterval(heartbeat)
      clearTimeout(timeout)
      hostSignal.removeEventListener("abort", abortFromHost)
    }
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
}

export function assertCredentialMutationOperationActive(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}

export function connectorAuthorizationStatusError(
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

function credentialMutationFence(authorization: ConnectorAuthorizationRecord) {
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

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : createAmbiguousProviderOperationError()
}

function staleReauthorizationError(): ReturnType<typeof createConnectorCodedError> {
  return createConnectorCodedError(
    "connector.authorization_invalid",
    "Connector reauthorization attempt is stale; restart authorization."
  )
}
