import { AuthorizationError } from "../../authorization"
import type { AuthorizablePrincipal } from "../../execution"
import { ConnectorConnectionStorageError } from "../../storage"
import type { CreateExecutionInput, ExecutionRecord } from "../../storage/executions"

export interface ConnectorConnectionCommandActor {
  readonly principal: AuthorizablePrincipal
  readonly credential:
    | { readonly type: "session"; readonly id: string }
    | { readonly type: "accessToken"; readonly id: string }
}

/** Validate and recover the authenticated actor carried by one durable request execution. */
export function requireConnectorConnectionCommandActor(
  execution: CreateExecutionInput,
  projectId: string
): ConnectorConnectionCommandActor {
  const actor = connectorConnectionActorFromExecution(execution, projectId)
  if (actor) return actor

  throw new AuthorizationError(
    "manage:connector",
    "[Sixb] Connector connection commands require an authenticated request execution."
  )
}

/**
 * Bind an OAuth callback to the same principal and credential that initiated its attempt.
 *
 * The storage error intentionally shares the regular invalid-attempt path: callers must not learn
 * whether a valid state belongs to another authenticated actor.
 */
export function assertConnectorAuthorizationAttemptInitiator(
  execution: ExecutionRecord | null,
  current: ConnectorConnectionCommandActor
): asserts execution is ExecutionRecord {
  const initiating = execution
    ? connectorConnectionActorFromExecution(execution, execution.projectId)
    : null
  if (!initiating || !sameConnectorConnectionCommandActor(initiating, current)) {
    throw new ConnectorConnectionStorageError(
      "attempt_invalid",
      "[Sixb] Connector authorization attempt is invalid, expired, or already used."
    )
  }
}

export function assertConnectorConnectionRunInitiator(
  execution: ExecutionRecord | null,
  current: ConnectorConnectionCommandActor,
  connectorId: string
): asserts execution is ExecutionRecord {
  const initiating = execution
    ? connectorConnectionActorFromExecution(execution, execution.projectId)
    : null
  if (!initiating || !sameConnectorConnectionCommandActor(initiating, current)) {
    throw new AuthorizationError(
      `connection-run:connector:${connectorId}`,
      "[Sixb] This connector connection run can only be accessed by its initiating actor."
    )
  }
}

function connectorConnectionActorFromExecution(
  execution: CreateExecutionInput | ExecutionRecord,
  projectId: string
): ConnectorConnectionCommandActor | null {
  const authorization = execution.authorizationRef
  if (
    execution.projectId !== projectId ||
    execution.executor.type !== "request" ||
    execution.source.type !== "http" ||
    execution.executor.requestId !== execution.source.requestId ||
    authorization.type !== "principal" ||
    authorization.credential === undefined ||
    execution.requestedBy?.type !== authorization.principal.type ||
    execution.requestedBy.id !== authorization.principal.id
  ) {
    return null
  }

  return {
    principal: authorization.principal,
    credential: authorization.credential,
  }
}

function sameConnectorConnectionCommandActor(
  left: ConnectorConnectionCommandActor,
  right: ConnectorConnectionCommandActor
): boolean {
  return (
    left.principal.type === right.principal.type &&
    left.principal.id === right.principal.id &&
    left.credential.type === right.credential.type &&
    left.credential.id === right.credential.id
  )
}
