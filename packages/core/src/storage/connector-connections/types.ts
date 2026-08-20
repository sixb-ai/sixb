import type {
  ConnectorAccountCandidate,
  ConnectorConnectionSelector,
  SealedConnectorCredential,
} from "../../connectors"
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
  readonly reauthorizationConnectionIds?: readonly string[]
  readonly createdAt: Date
  readonly expiresAt: Date
}

export interface ConsumeConnectorAuthorizationAttemptInput {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly authorizedBy: AuthorizablePrincipal
  readonly credential: ConnectorAuthorizationCredential
  readonly stateHash: string
  readonly redirectUri: string
  readonly now: Date
}

export type ConnectorAuthorizationStatus = "active" | "needs_reauthorization" | "revoked"

export interface ConnectorRefreshLease {
  readonly id: string
  readonly holderId: string
  readonly expiresAt: Date
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
  readonly revision: number
  readonly refreshLease?: ConnectorRefreshLease
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
  readonly createdAt: Date
}

export interface ClaimConnectorRefreshLeaseInput {
  readonly authorizationId: string
  readonly expectedRevision: number
  readonly lease: Omit<ConnectorRefreshLease, "expiresAt">
  readonly durationMs: number
}

export interface UpdateConnectorAuthorizationCredentialsInput {
  readonly authorizationId: string
  readonly expectedRevision: number
  readonly leaseId: string
  readonly credentials: SealedConnectorCredential
  readonly credentialExpiresAt?: Date
  readonly scopes: readonly string[]
  readonly updatedAt: Date
}

export interface ReauthorizeConnectorAuthorizationInput {
  readonly authorizationId: string
  readonly expectedRevision: number
  readonly expectedConnectionIds: readonly string[]
  readonly credentials: SealedConnectorCredential
  readonly credentialExpiresAt?: Date
  readonly scopes: readonly string[]
  readonly accounts: readonly ConnectorAccountCandidate[]
  readonly updatedAt: Date
}

export interface ReleaseConnectorRefreshLeaseInput {
  readonly authorizationId: string
  readonly expectedRevision: number
  readonly leaseId: string
  readonly updatedAt: Date
}

export interface MarkConnectorAuthorizationInput {
  readonly authorizationId: string
  readonly expectedRevision: number
  readonly leaseId?: string
  readonly updatedAt: Date
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
  readonly now: Date
}

export interface PutConnectorConnectionResult {
  readonly connection: ConnectorConnectionRecord
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

export interface RevokeConnectorAuthorizationInput {
  readonly projectId: string
  readonly connectorId: string
  readonly authorizationId: string
  readonly expectedRevision: number
  readonly revokedAt: Date
}

export interface RevokeConnectorAuthorizationResult {
  readonly authorization: ConnectorAuthorizationRecord
  readonly disconnected: readonly ConnectorConnectionRecord[]
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
  getAuthorization(authorizationId: string): Promise<ConnectorAuthorizationRecord | null>
  claimRefreshLease(
    input: ClaimConnectorRefreshLeaseInput
  ): Promise<ConnectorAuthorizationRecord | null>
  updateAuthorizationCredentials(
    input: UpdateConnectorAuthorizationCredentialsInput
  ): Promise<ConnectorAuthorizationRecord | null>
  reauthorizeAuthorization(
    input: ReauthorizeConnectorAuthorizationInput
  ): Promise<ConnectorAuthorizationRecord | null>
  releaseRefreshLease(input: ReleaseConnectorRefreshLeaseInput): Promise<boolean>
  markNeedsReauthorization(
    input: MarkConnectorAuthorizationInput
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
  revokeAuthorization(
    input: RevokeConnectorAuthorizationInput
  ): Promise<RevokeConnectorAuthorizationResult | null>
}
