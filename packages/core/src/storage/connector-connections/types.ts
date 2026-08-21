import type { ConnectorAccountCandidate, ConnectorConnectionSelector } from "../../connectors"
import type { SealedConnectorCredential } from "../../connectors/credentials"
import type { AuthorizablePrincipal, AuthorizationRef } from "../../execution"

export type {
  ConnectorConnectionOwner,
  ConnectorConnectionSelector,
  ProjectConnectorConnectionOwner,
} from "../../connectors"

export type ConnectorAuthorizationCredential = NonNullable<
  Extract<AuthorizationRef, { readonly type: "principal" }>["credential"]
>

export interface ConnectorAuthorizationAttemptRecord extends ConnectorConnectionSelector {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly authorizedBy: AuthorizablePrincipal
  readonly credential: ConnectorAuthorizationCredential
  readonly stateHash: string
  readonly codeVerifier: SealedConnectorCredential
  readonly redirectUri: string
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
  readonly authorizedBy: AuthorizablePrincipal
  readonly credential: ConnectorAuthorizationCredential
  readonly stateHash: string
  readonly codeVerifier: SealedConnectorCredential
  readonly redirectUri: string
  readonly reauthorizationId?: string
  readonly reauthorizationRevision?: number
  readonly reauthorizationConnectionIds?: readonly string[]
  readonly ttlMs: number
}

export interface ConsumeConnectorAuthorizationAttemptInput {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly authorizedBy: AuthorizablePrincipal
  readonly credential: ConnectorAuthorizationCredential
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
  readonly credentials: SealedConnectorCredential
  readonly credentialExpiresAt?: Date
  readonly scopes: readonly string[]
  readonly accounts: readonly ConnectorAccountCandidate[]
  readonly status: ConnectorAuthorizationStatus
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

export interface ConnectorConnectionRecord extends ConnectorConnectionSelector {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly authorizationId: string
  readonly account: ConnectorAccountCandidate
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
  readonly created: boolean
  readonly replaced: boolean
}

export interface GetConnectorConnectionInput extends ConnectorConnectionSelector {
  readonly projectId: string
  readonly connectorId: string
}

export interface DisconnectConnectorConnectionInput {
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

  createAuthorization(
    input: CreateConnectorAuthorizationInput
  ): Promise<ConnectorAuthorizationRecord>
  initializeAuthorizationAccounts(
    input: InitializeConnectorAuthorizationAccountsInput
  ): Promise<ConnectorAuthorizationRecord | null>
  getAuthorization(authorizationId: string): Promise<ConnectorAuthorizationRecord | null>
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
  getConnection(input: GetConnectorConnectionInput): Promise<ConnectorConnectionRecord | null>
  getConnectionById(connectionId: string): Promise<ConnectorConnectionRecord | null>
  listConnectionsByAuthorization(
    authorizationId: string
  ): Promise<readonly ConnectorConnectionRecord[]>
  disconnectConnection(
    input: DisconnectConnectorConnectionInput
  ): Promise<ConnectorConnectionRecord | null>
}
