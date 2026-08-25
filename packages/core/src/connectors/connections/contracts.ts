import type { ConnectorAuthorizationStatus } from "../../storage/connector-connections/types"
import type { CreateExecutionInput } from "../../storage/executions/types"
import type { ConnectorAccountCandidate, ConnectorConnectionSelector } from "../types"

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

export interface CompleteConnectorAuthorizationInput {
  readonly state: string
  readonly code: string
  readonly redirectUri: string
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

export interface ConnectorConnectionView extends ConnectorConnectionSelector {
  readonly id: string
  readonly connectorId: string
  readonly account: ConnectorAccountCandidate
  readonly status: ConnectorAuthorizationStatus
}

export interface RevokeConnectorAuthorizationResult {
  readonly affectedConnections: readonly ConnectorConnectionView[]
}

/** Process-owned OAuth lifecycle port. Connector definitions are resolved behind this boundary. */
export interface ConnectorConnectionProcess {
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
