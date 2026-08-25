import type { ConnectorAccountCandidate, ConnectorConnectionSelector } from "../../connectors"
import type { SealedConnectorCredential } from "../../connectors/credentials"
import type { SixbErrorCode, SixbFailure } from "../../errors/types"
import type { AuthorizablePrincipal } from "../../execution"

export type {
  ConnectorConnectionOwner,
  ConnectorConnectionSelector,
  ProjectConnectorConnectionOwner,
} from "../../connectors"

export const CONNECTOR_CONNECTION_RUN_FAILURE_CODES = [
  "internal.unexpected",
  "connector.adapter_invalid",
  "connector.authorization_invalid",
  "connector.authorization_required",
  "connector.credentials_unavailable",
  "connector.not_found",
  "connector.operation_conflict",
  "connector.operation_in_progress",
  "connector.provider_failed",
  "connector.provider_unavailable",
] as const satisfies readonly [SixbErrorCode, ...SixbErrorCode[]]

export type ConnectorConnectionRunFailureCode =
  (typeof CONNECTOR_CONNECTION_RUN_FAILURE_CODES)[number]
export type ConnectorConnectionRunFailure = SixbFailure<ConnectorConnectionRunFailureCode>
export type ConnectorConnectionRunKind = "connect" | "reauthorize"

interface ConnectorConnectionRunBase extends ConnectorConnectionSelector {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly kind: ConnectorConnectionRunKind
  /** Durable request execution that initiated and is allowed to manage this run. */
  readonly initiatedByExecutionId: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface ConnectorConnectionRunAwaitingProviderRecord extends ConnectorConnectionRunBase {
  readonly status: "waiting"
  readonly waitingFor: "provider_authorization"
  readonly authorizationAttemptId: string
  readonly expiresAt: Date
}

export interface ConnectorConnectionRunProcessingRecord extends ConnectorConnectionRunBase {
  readonly status: "running"
  readonly callbackStartedAt: Date
}

export interface ConnectorConnectionRunAwaitingSelectionRecord extends ConnectorConnectionRunBase {
  readonly status: "waiting"
  readonly waitingFor: "account_selection"
  readonly authorizationId: string
  readonly expiresAt: Date
}

export interface ConnectorConnectionRunSucceededRecord extends ConnectorConnectionRunBase {
  readonly status: "succeeded"
  readonly authorizationId: string
  readonly connections: readonly ConnectorConnectionRecord[]
  readonly finishedAt: Date
}

export interface ConnectorConnectionRunFailedRecord extends ConnectorConnectionRunBase {
  readonly status: "failed"
  readonly error: ConnectorConnectionRunFailure
  readonly finishedAt: Date
}

export interface ConnectorConnectionRunCancelledRecord extends ConnectorConnectionRunBase {
  readonly status: "cancelled"
  readonly finishedAt: Date
}

export interface ConnectorConnectionRunExpiredRecord extends ConnectorConnectionRunBase {
  readonly status: "expired"
  readonly finishedAt: Date
}

export type ConnectorConnectionRunRecord =
  | ConnectorConnectionRunAwaitingProviderRecord
  | ConnectorConnectionRunProcessingRecord
  | ConnectorConnectionRunAwaitingSelectionRecord
  | ConnectorConnectionRunSucceededRecord
  | ConnectorConnectionRunFailedRecord
  | ConnectorConnectionRunCancelledRecord
  | ConnectorConnectionRunExpiredRecord

export interface CreateConnectorConnectionRunInput extends ConnectorConnectionSelector {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly kind: ConnectorConnectionRunKind
  readonly initiatedByExecutionId: string
  readonly authorizationAttemptId: string
  readonly ttlMs: number
}

export interface ClaimConnectorConnectionRunCallbackInput {
  readonly projectId: string
  readonly attemptId: string
  readonly stateHash: string
  readonly callbackBindingHash: string
  readonly redirectUri: string
}

export type ClaimConnectorConnectionRunCallbackResult =
  | {
      readonly type: "claimed"
      readonly run: ConnectorConnectionRunProcessingRecord
      readonly attempt: ConnectorAuthorizationAttemptRecord
      readonly returnTo: string
    }
  | {
      readonly type: "expired"
      readonly run: ConnectorConnectionRunExpiredRecord
      readonly returnTo: string
    }

export interface WaitForConnectorConnectionRunSelectionInput {
  readonly projectId: string
  readonly connectorId: string
  readonly runId: string
  readonly authorizationId: string
  readonly expiresAt: Date
}

export type FinishConnectorConnectionRunInput =
  | {
      readonly projectId: string
      readonly connectorId: string
      readonly runId: string
      readonly status: "succeeded"
      readonly authorizationId: string
      readonly connections: readonly ConnectorConnectionRecord[]
    }
  | {
      readonly projectId: string
      readonly connectorId: string
      readonly runId: string
      readonly status: "failed"
      readonly error: ConnectorConnectionRunFailure
    }
  | {
      readonly projectId: string
      readonly connectorId: string
      readonly runId: string
      readonly status: "cancelled"
    }

export interface GetConnectorConnectionRunInput {
  readonly projectId: string
  readonly connectorId: string
  readonly runId: string
}

export interface ConnectorAuthorizationAttemptRecord extends ConnectorConnectionSelector {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  /** Durable execution that initiated and authorizes completion of this OAuth attempt. */
  readonly initiatedByExecutionId: string
  readonly stateHash: string
  readonly codeVerifier: SealedConnectorCredential
  readonly redirectUri: string
  /** Present only for attempts created by the headless connection-run API. */
  readonly connectionRunId?: string
  /** Fixed, allowlisted continuation consumed with a headless callback. */
  readonly returnTo?: string
  /** Hash of the one-shot browser callback binding secret. */
  readonly callbackBindingHash?: string
  readonly reauthorizationId?: string
  readonly reauthorizationRevision?: number
  readonly reauthorizationConnectionIds?: readonly string[]
  readonly createdAt: Date
  readonly expiresAt: Date
}

export interface CreateConnectorAuthorizationAttemptInput extends ConnectorConnectionSelector {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly initiatedByExecutionId: string
  readonly stateHash: string
  readonly codeVerifier: SealedConnectorCredential
  readonly redirectUri: string
  readonly connectionRunId?: string
  readonly returnTo?: string
  readonly callbackBindingHash?: string
  readonly reauthorizationId?: string
  readonly reauthorizationRevision?: number
  readonly reauthorizationConnectionIds?: readonly string[]
  readonly ttlMs: number
}

/** Callback proof. The orchestration layer authorizes the returned initiating execution. */
export interface ConsumeConnectorAuthorizationAttemptInput {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly stateHash: string
  readonly redirectUri: string
}

export type ConnectorAuthorizationStatus =
  | "pending_selection"
  | "active"
  | "needs_reauthorization"
  | "revocation_pending"
  | "revoked"

export type ConnectorCredentialMutationKind = "refresh" | "reauthorization" | "revocation"
export type ConnectorCredentialMutationPhase = "prepared" | "executing" | "result_staged"

export interface ConnectorStagedCredentials {
  readonly credentials: SealedConnectorCredential
  readonly credentialExpiresAt?: Date
  readonly scopes: readonly string[]
}

/** Durable fencing record for one provider-side OAuth credential mutation. */
export interface ConnectorCredentialMutation {
  readonly id: string
  readonly kind: ConnectorCredentialMutationKind
  readonly phase: ConnectorCredentialMutationPhase
  readonly holderId: string
  readonly expiresAt: Date
  readonly deadlineAt: Date
  readonly expectedConnectionIds?: readonly string[]
  readonly stagedCredentials?: ConnectorStagedCredentials
}

export interface ConnectorAuthorizationRecord {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly authorizedBy: AuthorizablePrincipal
  /** Removed after provider revocation is confirmed. */
  readonly credentials?: SealedConnectorCredential
  readonly credentialExpiresAt?: Date
  readonly scopes: readonly string[]
  readonly accounts: readonly ConnectorAccountCandidate[]
  readonly status: ConnectorAuthorizationStatus
  /** Secret-free snapshots retained so revocation stays addressable by former connection IDs. */
  readonly revocationConnections?: readonly ConnectorConnectionRecord[]
  /** Storage-authoritative deadline for the first account selection. */
  readonly selectionExpiresAt?: Date
  readonly revision: number
  readonly credentialMutation?: ConnectorCredentialMutation
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateConnectorAuthorizationInput {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly authorizedBy: AuthorizablePrincipal
  readonly credentials: SealedConnectorCredential
  readonly credentialExpiresAt?: Date
  readonly scopes: readonly string[]
  readonly accounts: readonly ConnectorAccountCandidate[]
  readonly selectionTtlMs: number
}

export interface InitializeConnectorAuthorizationAccountsInput {
  readonly projectId: string
  readonly connectorId: string
  readonly authorizationId: string
  readonly expectedRevision: number
  readonly accounts: readonly ConnectorAccountCandidate[]
}

export interface ClaimConnectorCredentialMutationInput {
  readonly projectId: string
  readonly connectorId: string
  readonly authorizationId: string
  readonly expectedRevision: number
  readonly mutation: {
    readonly id: string
    readonly kind: ConnectorCredentialMutationKind
    readonly holderId: string
  }
  readonly expectedConnectionIds?: readonly string[]
  readonly leaseDurationMs: number
  readonly operationTimeoutMs: number
}

export interface ClaimConnectorCredentialMutationResult {
  readonly authorization: ConnectorAuthorizationRecord
  readonly disconnected: readonly ConnectorConnectionRecord[]
}

export interface ConnectorCredentialMutationFence {
  readonly projectId: string
  readonly connectorId: string
  readonly authorizationId: string
  readonly expectedRevision: number
  readonly mutationId: string
}

export interface MarkConnectorCredentialMutationExecutingInput
  extends ConnectorCredentialMutationFence {
  readonly holderId: string
}

export interface RenewConnectorCredentialMutationInput extends ConnectorCredentialMutationFence {
  readonly holderId: string
  readonly leaseDurationMs: number
}

export interface StageConnectorCredentialMutationCredentialsInput
  extends ConnectorCredentialMutationFence {
  readonly holderId: string
  readonly credentials: SealedConnectorCredential
  readonly credentialExpiresAt?: Date
  readonly scopes: readonly string[]
}

export interface StageConnectorCredentialMutationRevocationInput
  extends ConnectorCredentialMutationFence {
  readonly holderId: string
}

export interface ReleaseConnectorCredentialMutationInput extends ConnectorCredentialMutationFence {
  readonly holderId: string
}

export interface RecoverExpiredConnectorCredentialMutationInput {
  readonly projectId: string
  readonly connectorId: string
  readonly authorizationId: string
}

export interface MarkConnectorAuthorizationNeedsReauthorizationInput
  extends ConnectorCredentialMutationFence {}

export interface FinalizeConnectorReauthorizationInput extends ConnectorCredentialMutationFence {
  readonly accounts: readonly ConnectorAccountCandidate[]
}

export type ConnectorConnectionStatus = "connected" | "disconnected"

export interface ConnectorConnectionRecord extends ConnectorConnectionSelector {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly authorizationId: string
  readonly account: ConnectorAccountCandidate
  readonly status: ConnectorConnectionStatus
  readonly disconnectedAt?: Date
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface PutConnectorConnectionInput extends ConnectorConnectionSelector {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly authorizationId: string
  readonly account: ConnectorAccountCandidate
  readonly replace: boolean
}

export interface PutConnectorConnectionResult {
  readonly connection: ConnectorConnectionRecord
  readonly authorization: ConnectorAuthorizationRecord
  /** Previous grant made unreachable by this atomic slot replacement. */
  readonly revocationPendingAuthorizationId?: string
  readonly created: boolean
  readonly replaced: boolean
}

export interface DisconnectConnectorConnectionResult {
  readonly connection: ConnectorConnectionRecord
  readonly authorization: ConnectorAuthorizationRecord
  /** Present when disconnecting this record removed the grant's last connected usage. */
  readonly revocationPendingAuthorizationId?: string
}

export interface PutConnectorConnectionFromRunInput {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly runId: string
  readonly account: ConnectorAccountCandidate
  readonly replace: boolean
}

export interface PutConnectorConnectionFromRunResult extends PutConnectorConnectionResult {
  readonly run: ConnectorConnectionRunSucceededRecord
}

export interface GetConnectorConnectionInput extends ConnectorConnectionSelector {
  readonly projectId: string
  readonly connectorId: string
}

export interface ListConnectorConnectionsInput {
  readonly projectId: string
  readonly connectorId: string
}

/** Tenant-scoped identity for one connector authorization. */
export interface ConnectorAuthorizationKey {
  readonly projectId: string
  readonly connectorId: string
  readonly authorizationId: string
}

/** Tenant-scoped identity for one selected connector connection. */
export interface ConnectorConnectionKey {
  readonly projectId: string
  readonly connectorId: string
  readonly connectionId: string
}

/** Persistent contract. Implementations must make every individual mutation atomic. */
export interface ConnectorConnectionStorage {
  readonly durability: "ephemeral" | "durable"

  createAuthorizationAttempt(
    input: CreateConnectorAuthorizationAttemptInput
  ): Promise<ConnectorAuthorizationAttemptRecord>
  consumeAuthorizationAttempt(
    input: ConsumeConnectorAuthorizationAttemptInput
  ): Promise<ConnectorAuthorizationAttemptRecord>

  createConnectionRun(
    input: CreateConnectorConnectionRunInput
  ): Promise<ConnectorConnectionRunRecord>
  claimConnectionRunCallback(
    input: ClaimConnectorConnectionRunCallbackInput
  ): Promise<ClaimConnectorConnectionRunCallbackResult | null>
  waitForConnectionRunSelection(
    input: WaitForConnectorConnectionRunSelectionInput
  ): Promise<ConnectorConnectionRunAwaitingSelectionRecord | null>
  finishConnectionRun(
    input: FinishConnectorConnectionRunInput
  ): Promise<ConnectorConnectionRunRecord | null>
  getConnectionRun(
    input: GetConnectorConnectionRunInput
  ): Promise<ConnectorConnectionRunRecord | null>

  createAuthorization(
    input: CreateConnectorAuthorizationInput
  ): Promise<ConnectorAuthorizationRecord>
  initializeAuthorizationAccounts(
    input: InitializeConnectorAuthorizationAccountsInput
  ): Promise<ConnectorAuthorizationRecord | null>
  getAuthorization(input: ConnectorAuthorizationKey): Promise<ConnectorAuthorizationRecord | null>
  getAuthorizationByConnectionId(
    input: ConnectorConnectionKey
  ): Promise<ConnectorAuthorizationRecord | null>
  claimCredentialMutation(
    input: ClaimConnectorCredentialMutationInput
  ): Promise<ClaimConnectorCredentialMutationResult | null>
  markCredentialMutationExecuting(
    input: MarkConnectorCredentialMutationExecutingInput
  ): Promise<ConnectorAuthorizationRecord | null>
  renewCredentialMutation(
    input: RenewConnectorCredentialMutationInput
  ): Promise<ConnectorAuthorizationRecord | null>
  stageCredentialMutationCredentials(
    input: StageConnectorCredentialMutationCredentialsInput
  ): Promise<ConnectorAuthorizationRecord | null>
  stageCredentialMutationRevocation(
    input: StageConnectorCredentialMutationRevocationInput
  ): Promise<ConnectorAuthorizationRecord | null>
  releaseCredentialMutation(input: ReleaseConnectorCredentialMutationInput): Promise<boolean>
  /**
   * Recovers an expired mutation without replaying an unknown provider effect. Prepared work is
   * released, executing refresh/reauthorization fails closed, revocation stays retryable, and a
   * staged result remains available for finalization.
   */
  recoverExpiredCredentialMutation(
    input: RecoverExpiredConnectorCredentialMutationInput
  ): Promise<ConnectorAuthorizationRecord | null>
  markNeedsReauthorization(
    input: MarkConnectorAuthorizationNeedsReauthorizationInput
  ): Promise<ConnectorAuthorizationRecord | null>
  finalizeRefresh(
    input: ConnectorCredentialMutationFence
  ): Promise<ConnectorAuthorizationRecord | null>
  finalizeReauthorization(
    input: FinalizeConnectorReauthorizationInput
  ): Promise<ConnectorAuthorizationRecord | null>
  finalizeRevocation(
    input: ConnectorCredentialMutationFence
  ): Promise<ConnectorAuthorizationRecord | null>

  putConnection(input: PutConnectorConnectionInput): Promise<PutConnectorConnectionResult>
  putConnectionFromRun(
    input: PutConnectorConnectionFromRunInput
  ): Promise<PutConnectorConnectionFromRunResult>
  getConnection(input: GetConnectorConnectionInput): Promise<ConnectorConnectionRecord | null>
  getConnectionById(input: ConnectorConnectionKey): Promise<ConnectorConnectionRecord | null>
  /** Lists durable connection identities, including disconnected records. */
  listConnections(
    input: ListConnectorConnectionsInput
  ): Promise<readonly ConnectorConnectionRecord[]>
  /** Lists only connections currently attached to the authorization. */
  listConnectionsByAuthorization(
    input: ConnectorAuthorizationKey
  ): Promise<readonly ConnectorConnectionRecord[]>
  disconnectConnection(
    input: ConnectorConnectionKey
  ): Promise<DisconnectConnectorConnectionResult | null>
}
