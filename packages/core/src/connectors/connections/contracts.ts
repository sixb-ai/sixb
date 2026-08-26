import type {
  ConnectorConnectionRunFailure,
  ConnectorConnectionRunKind,
} from "../../storage/connector-connections/types"
import type { CreateExecutionInput } from "../../storage/executions/types"
import type {
  ConnectorAccountCandidate,
  ConnectorConnectionMetadata,
  ConnectorConnectionSelector,
} from "../types"

/** Durable, already-authorized request provenance carried into the process-owned OAuth service. */
export interface ConnectorConnectionCommandContext {
  readonly execution: CreateExecutionInput
}

export interface StartConnectorAuthorizationInput extends ConnectorConnectionSelector {
  readonly redirectUri: string
  readonly reauthorizationId?: string
}

export interface StartConnectorAuthorizationResult {
  readonly authorizationUrl: string
  readonly affectedConnections: readonly ConnectorConnectionView[]
}

export interface StartConnectorConnectionRunInput extends ConnectorConnectionSelector {
  readonly redirectUri: string
  readonly returnTo: string
  readonly reauthorizationId?: string
}

export interface StartConnectorConnectionRunResult {
  readonly runId: string
  readonly authorizationUrl: string
  readonly affectedConnections: readonly ConnectorConnectionView[]
  /** One-shot browser proof set as an HttpOnly callback cookie by the HTTP boundary. */
  readonly callbackBinding: {
    readonly attemptId: string
    readonly secret: string
    readonly expiresAt: Date
  }
}

export interface CompleteConnectorAuthorizationInput {
  readonly state: string
  readonly code: string
  readonly redirectUri: string
}

export type CompleteConnectorConnectionRunInput =
  | {
      readonly state: string
      readonly code: string
      readonly redirectUri: string
      readonly callbackBinding: string
    }
  | {
      readonly state: string
      readonly error: string
      readonly redirectUri: string
      readonly callbackBinding: string
    }

export interface CompleteConnectorConnectionRunResult {
  readonly runId: string
  readonly connectorId: string
  readonly returnTo: string
}

/** Internal selection result. The HTTP boundary maps it to a secret-free representation. */
export interface CompleteConnectorAuthorizationResult extends ConnectorConnectionSelector {
  readonly authorizationId: string
  readonly accounts: readonly ConnectorAccountCandidate[]
}

export interface SelectConnectorAccountInput extends ConnectorConnectionSelector {
  readonly authorizationId: string
  readonly accountId: string
  readonly replace?: boolean
}

export interface SelectConnectorConnectionRunAccountInput {
  readonly runId: string
  readonly accountId: string
  readonly replace?: boolean
}

export interface AddConnectorConnectionInput extends ConnectorConnectionSelector {
  readonly fromConnectionId: string
}

export interface ConnectorConnectionView extends ConnectorConnectionMetadata {
  readonly status: "connected" | "needs_reauthorization" | "disconnected"
}

interface ConnectorConnectionRunViewBase extends ConnectorConnectionSelector {
  readonly id: string
  readonly connectorId: string
  readonly kind: ConnectorConnectionRunKind
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type ConnectorConnectionRunView =
  | (ConnectorConnectionRunViewBase & {
      readonly status: "waiting"
      readonly waitingFor: "provider_authorization"
      readonly expiresAt: Date
    })
  | (ConnectorConnectionRunViewBase & {
      readonly status: "running"
    })
  | (ConnectorConnectionRunViewBase & {
      readonly status: "waiting"
      readonly waitingFor: "account_selection"
      readonly accounts: readonly ConnectorAccountCandidate[]
      readonly expiresAt: Date
    })
  | (ConnectorConnectionRunViewBase & {
      readonly status: "succeeded"
      readonly connections: readonly ConnectorConnectionView[]
      readonly finishedAt: Date
    })
  | (ConnectorConnectionRunViewBase & {
      readonly status: "failed"
      readonly error: ConnectorConnectionRunFailure
      readonly finishedAt: Date
    })
  | (ConnectorConnectionRunViewBase & {
      readonly status: "cancelled" | "expired"
      readonly finishedAt: Date
    })

export interface RevokeConnectorAuthorizationResult {
  readonly affectedConnections: readonly ConnectorConnectionView[]
}

export interface ConnectorConnectionCallbackProcess {
  completeConnectionRun(
    input: CompleteConnectorConnectionRunInput
  ): Promise<CompleteConnectorConnectionRunResult>
}

/** Process-owned OAuth lifecycle port. Connector definitions are resolved behind this boundary. */
export interface ConnectorConnectionProcess {
  readonly callbackProcess: ConnectorConnectionCallbackProcess
  listConnections(
    context: ConnectorConnectionCommandContext,
    connectorId: string
  ): Promise<readonly ConnectorConnectionView[]>
  startConnectionRun(
    context: ConnectorConnectionCommandContext,
    connectorId: string,
    input: StartConnectorConnectionRunInput
  ): Promise<StartConnectorConnectionRunResult>
  addConnection(
    context: ConnectorConnectionCommandContext,
    connectorId: string,
    input: AddConnectorConnectionInput
  ): Promise<ConnectorConnectionRunView>
  getConnectionRun(
    context: ConnectorConnectionCommandContext,
    connectorId: string,
    runId: string
  ): Promise<ConnectorConnectionRunView | null>
  selectConnectionRunAccount(
    context: ConnectorConnectionCommandContext,
    connectorId: string,
    input: SelectConnectorConnectionRunAccountInput
  ): Promise<ConnectorConnectionRunView>
  startReauthorization(
    context: ConnectorConnectionCommandContext,
    connectorId: string,
    connectionId: string,
    input: Pick<StartConnectorConnectionRunInput, "redirectUri" | "returnTo">
  ): Promise<StartConnectorConnectionRunResult>
  revokeConnection(
    context: ConnectorConnectionCommandContext,
    connectorId: string,
    connectionId: string
  ): Promise<RevokeConnectorAuthorizationResult>
  startAuthorization(
    context: ConnectorConnectionCommandContext,
    connectorId: string,
    input: StartConnectorAuthorizationInput
  ): Promise<StartConnectorAuthorizationResult>
  completeAuthorization(
    context: ConnectorConnectionCommandContext,
    connectorId: string,
    input: CompleteConnectorAuthorizationInput
  ): Promise<CompleteConnectorAuthorizationResult>
  selectAccount(
    context: ConnectorConnectionCommandContext,
    connectorId: string,
    input: SelectConnectorAccountInput
  ): Promise<ConnectorConnectionView>
  disconnect(
    context: ConnectorConnectionCommandContext,
    connectorId: string,
    connectionId: string
  ): Promise<ConnectorConnectionView | null>
  revokeAuthorization(
    context: ConnectorConnectionCommandContext,
    connectorId: string,
    authorizationId: string
  ): Promise<RevokeConnectorAuthorizationResult>
}
