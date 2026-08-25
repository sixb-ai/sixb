import { AuthorizationError, assertCanManageConnector } from "../../authorization"
import { resolveExecutionScopeAuthorization } from "../../execution/authorization"
import { executionRecordInputFromRuntime } from "../../execution/durable"
import type { ExecutionContext } from "../../execution/types"
import type { SixbRuntimeContext } from "../../runtime/types"
import type {
  AddConnectorConnectionInput,
  CompleteConnectorAuthorizationInput,
  CompleteConnectorAuthorizationResult,
  ConnectorConnectionCommandContext,
  ConnectorConnectionProcess,
  ConnectorConnectionRunView,
  ConnectorConnectionView,
  RevokeConnectorAuthorizationResult,
  SelectConnectorAccountInput,
  SelectConnectorConnectionRunAccountInput,
  StartConnectorAuthorizationInput,
  StartConnectorAuthorizationResult,
  StartConnectorConnectionRunInput,
  StartConnectorConnectionRunResult,
} from "./contracts"

/** Internal connector-connection lifecycle API bound to one authenticated request execution. */
export interface ConnectorConnectionsRuntime {
  listConnections(connectorId: string): Promise<readonly ConnectorConnectionView[]>
  startConnectionRun(
    connectorId: string,
    input: StartConnectorConnectionRunInput
  ): Promise<StartConnectorConnectionRunResult>
  addConnection(
    connectorId: string,
    input: AddConnectorConnectionInput
  ): Promise<ConnectorConnectionRunView>
  getConnectionRun(connectorId: string, runId: string): Promise<ConnectorConnectionRunView | null>
  selectConnectionRunAccount(
    connectorId: string,
    input: SelectConnectorConnectionRunAccountInput
  ): Promise<ConnectorConnectionRunView>
  startReauthorization(
    connectorId: string,
    connectionId: string,
    input: Pick<StartConnectorConnectionRunInput, "redirectUri" | "returnTo">
  ): Promise<StartConnectorConnectionRunResult>
  revokeConnection(
    connectorId: string,
    connectionId: string
  ): Promise<RevokeConnectorAuthorizationResult>
  startAuthorization(
    connectorId: string,
    input: StartConnectorAuthorizationInput
  ): Promise<StartConnectorAuthorizationResult>
  completeAuthorization(
    connectorId: string,
    input: CompleteConnectorAuthorizationInput
  ): Promise<CompleteConnectorAuthorizationResult>
  selectAccount(
    connectorId: string,
    input: SelectConnectorAccountInput
  ): Promise<ConnectorConnectionView>
  disconnect(connectorId: string, connectionId: string): Promise<ConnectorConnectionView | null>
  revokeAuthorization(
    connectorId: string,
    authorizationId: string
  ): Promise<RevokeConnectorAuthorizationResult>
}

export function createConnectorConnectionsRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  process: ConnectorConnectionProcess
): ConnectorConnectionsRuntime {
  const contextFor = (connectorId: string) => commandContext(runtime, execution, connectorId)

  const connections: ConnectorConnectionsRuntime = {
    listConnections: (connectorId) => process.listConnections(contextFor(connectorId), connectorId),
    startConnectionRun: (connectorId, input) =>
      process.startConnectionRun(contextFor(connectorId), connectorId, input),
    addConnection: (connectorId, input) =>
      process.addConnection(contextFor(connectorId), connectorId, input),
    getConnectionRun: (connectorId, runId) =>
      process.getConnectionRun(contextFor(connectorId), connectorId, runId),
    selectConnectionRunAccount: (connectorId, input) =>
      process.selectConnectionRunAccount(contextFor(connectorId), connectorId, input),
    startReauthorization: (connectorId, connectionId, input) =>
      process.startReauthorization(contextFor(connectorId), connectorId, connectionId, input),
    revokeConnection: (connectorId, connectionId) =>
      process.revokeConnection(contextFor(connectorId), connectorId, connectionId),
    startAuthorization: (connectorId, input) =>
      process.startAuthorization(contextFor(connectorId), connectorId, input),
    completeAuthorization: (connectorId, input) =>
      process.completeAuthorization(contextFor(connectorId), connectorId, input),
    selectAccount: (connectorId, input) =>
      process.selectAccount(contextFor(connectorId), connectorId, input),
    disconnect: (connectorId, connectionId) =>
      process.disconnect(contextFor(connectorId), connectorId, connectionId),
    revokeAuthorization: (connectorId, authorizationId) =>
      process.revokeAuthorization(contextFor(connectorId), connectorId, authorizationId),
  }
  return Object.freeze(connections)
}

function commandContext(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  connectorId: string
): ConnectorConnectionCommandContext {
  const resolved = resolveExecutionScopeAuthorization(runtime.projectId, {
    execution,
    authorization: runtime.runtimeAuthorization,
  })

  if (
    execution.executor.type !== "request" ||
    resolved.type !== "principal" ||
    resolved.ref.type !== "principal"
  ) {
    throw new AuthorizationError(
      `manage:connector:${connectorId}`,
      "[Sixb] Connector connections can only be managed by an authenticated request."
    )
  }
  if (!resolved.ref.credential) {
    throw new AuthorizationError(
      `manage:connector:${connectorId}`,
      "[Sixb] Connector connection management requires a session or access token."
    )
  }

  assertCanManageConnector(runtime, connectorId)
  return Object.freeze({
    execution: Object.freeze(
      executionRecordInputFromRuntime({
        execution,
        runtimeAuthorization: runtime.runtimeAuthorization,
      })
    ),
  })
}
