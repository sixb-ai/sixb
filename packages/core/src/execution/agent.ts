import { type AgentExecutionAuthorization, agentServiceAccountId } from "../agents/authority"
import type { OntologySource } from "../ontology"
import { isBoundSixb, type Sixb } from "../runtime/sixb"
import type { CreateExecutionInput, ExecutionRecord } from "../storage/executions"
import { ExecutionStorageError } from "../storage/executions"

export { ensureExecutionRecord } from "./durable"

import { createAgentRuntimeAuthorization, getAuthorizationRef } from "./authorization"
import type {
  AuthorizablePrincipal,
  ExecutionContext,
  ExecutionScope,
  RuntimeAuthorization,
} from "./types"

/** Minimal host boundary required by agent workers. */
export interface AgentExecutionHost {
  readonly id: string
  withScope(scope: ExecutionScope): object
}

/** Whether a nested main-agent run can durably restore this request authority without widening it. */
export function canInheritMainAgentRuntimeAuthorization(
  authorization: RuntimeAuthorization
): boolean {
  const ref = getAuthorizationRef(authorization)
  return (
    ref.type === "disabled" ||
    (ref.type === "principal" && ref.principal.type === "user" && ref.credential !== undefined)
  )
}

/** Build the immutable child execution owned by one direct or Workflow Agent run. */
export function createAgentExecutionRecord(input: {
  readonly id: string
  readonly parent: ExecutionRecord
  readonly agentId: string
  readonly runId: string
  readonly principal: Extract<AuthorizablePrincipal, { readonly type: "serviceAccount" }>
}): CreateExecutionInput {
  assertAgentPrincipal(input.agentId, input.principal)
  return {
    id: input.id,
    projectId: input.parent.projectId,
    ...(input.parent.requestedBy === undefined
      ? {}
      : { requestedBy: structuredClone(input.parent.requestedBy) }),
    executor: { type: "agent", runId: input.runId },
    source: { type: "execution", executionId: input.parent.id },
    correlationId: input.parent.correlationId,
    authorizationRef: {
      type: "principal",
      principal: structuredClone(input.principal),
    },
  }
}

/** Build a main-agent execution that carries its direct request parent's authority reference. */
export function createInheritedMainAgentExecutionRecord(input: {
  readonly id: string
  readonly parent: ExecutionRecord
  readonly runId: string
}): CreateExecutionInput {
  return createInheritedAgentExecutionRecord(input)
}

/** Build an Agent execution that carries its parent's exact durable authority reference. */
export function createInheritedAgentExecutionRecord(input: {
  readonly id: string
  readonly parent: ExecutionRecord
  readonly runId: string
}): CreateExecutionInput {
  const authority = input.parent.authorizationRef
  if (
    authority.type !== "disabled" &&
    !(
      authority.type === "principal" &&
      authority.principal.type === "user" &&
      authority.credential !== undefined
    )
  ) {
    throw new ExecutionStorageError(
      "invalid_input",
      `[Sixb] Agent run '${input.runId}' requires inheritable user or auth-disabled authority.`
    )
  }

  return {
    id: input.id,
    projectId: input.parent.projectId,
    ...(input.parent.requestedBy === undefined
      ? {}
      : { requestedBy: structuredClone(input.parent.requestedBy) }),
    executor: { type: "agent", runId: input.runId },
    source: { type: "execution", executionId: input.parent.id },
    correlationId: input.parent.correlationId,
    authorizationRef: structuredClone(authority),
  }
}

/** Bind a worker to the immutable execution already owned by its durable Agent run. */
export function bindDurableAgentExecution(
  host: AgentExecutionHost,
  input: {
    readonly execution: ExecutionRecord
    readonly agentId?: string
    readonly runId: string
    readonly authorization: AgentExecutionAuthorization
  }
): Sixb<readonly OntologySource[]> {
  const scope = restoreAgentExecutionScope(input)
  const sixb = host.withScope(scope)
  if (!isBoundSixb(sixb)) {
    throw new Error("[Sixb] Agent execution host returned an invalid bound SDK.")
  }
  return sixb
}

/** Restore one provider-validated Agent execution with its currently resolved grants. */
export function restoreAgentExecutionScope(input: {
  readonly execution: ExecutionRecord
  readonly agentId?: string
  readonly runId: string
  readonly authorization: AgentExecutionAuthorization
}): ExecutionScope {
  assertAgentExecutionRecord(input)
  const context: ExecutionContext = Object.freeze({
    id: input.execution.id,
    projectId: input.execution.projectId,
    ...(input.execution.requestedBy === undefined
      ? {}
      : { requestedBy: Object.freeze(structuredClone(input.execution.requestedBy)) }),
    executor: Object.freeze({
      type: "agent",
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      runId: input.runId,
    }),
    source: Object.freeze(structuredClone(input.execution.source)),
    correlationId: input.execution.correlationId,
  })
  return Object.freeze({
    execution: context,
    authorization: createAgentRuntimeAuthorization({
      projectId: input.execution.projectId,
      executionId: input.execution.id,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      runId: input.runId,
      authority:
        input.authorization.type === "principal"
          ? {
              type: "principal",
              context: input.authorization.context,
              ...(input.execution.authorizationRef.type === "principal" &&
              input.execution.authorizationRef.credential !== undefined
                ? { credential: input.execution.authorizationRef.credential }
                : {}),
            }
          : { type: "disabled" },
    }),
  })
}

/** Validate that a durable record belongs to the exact resolved Agent execution. */
export function assertAgentExecutionRecord(input: {
  readonly execution: ExecutionRecord
  readonly agentId?: string
  readonly runId: string
  readonly authorization: AgentExecutionAuthorization
}): void {
  const authority = input.execution.authorizationRef
  if (
    input.execution.executor.type !== "agent" ||
    input.execution.executor.runId !== input.runId ||
    input.execution.source.type !== "execution"
  ) {
    invalidAgentExecution(input.execution.id, input.runId)
  }

  if (
    input.authorization.type === "disabled" ||
    input.authorization.context.principal.type === "user"
  ) {
    assertInheritedAgentAuthority(input.execution, input.runId, input.authorization)
    return
  }

  if (
    input.authorization.type !== "principal" ||
    authority.type !== "principal" ||
    authority.principal.type !== "serviceAccount" ||
    input.authorization.context.principal.type !== "serviceAccount" ||
    authority.principal.id !== input.authorization.context.principal.id ||
    authority.credential !== undefined
  ) {
    invalidAgentExecution(input.execution.id, input.runId)
  }
  if (input.agentId === undefined) {
    invalidAgentExecution(input.execution.id, input.runId)
  }
  assertAgentPrincipal(input.agentId, authority.principal)
}

function assertInheritedAgentAuthority(
  execution: ExecutionRecord,
  runId: string,
  authorization: AgentExecutionAuthorization
): void {
  const authority = execution.authorizationRef
  if (authorization.type === "disabled") {
    if (authority.type !== "disabled") invalidAgentExecution(execution.id, runId)
    return
  }

  const principal = authorization.context.principal
  if (
    authority.type !== "principal" ||
    authority.principal.type !== "user" ||
    principal.type !== "user" ||
    authority.principal.id !== principal.id ||
    authority.credential === undefined ||
    (authority.credential.type === "session"
      ? authorization.context.sessionId !== authority.credential.id
      : authorization.context.sessionId !== undefined)
  ) {
    invalidAgentExecution(execution.id, runId)
  }
}

function assertAgentPrincipal(
  agentId: string,
  principal: Extract<AuthorizablePrincipal, { readonly type: "serviceAccount" }>
): void {
  const expectedId = agentServiceAccountId(agentId)
  if (principal.id !== expectedId) {
    throw new ExecutionStorageError(
      "invalid_input",
      `[Sixb] Agent '${agentId}' execution authority must reference service account '${expectedId}'.`
    )
  }
}

function invalidAgentExecution(executionId: string, runId: string): never {
  throw new ExecutionStorageError(
    "invalid_input",
    `[Sixb] Execution '${executionId}' does not authorize Agent run '${runId}'.`
  )
}
