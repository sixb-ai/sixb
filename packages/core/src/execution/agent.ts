import { agentServiceAccountId } from "../agents/authority"
import type { AuthorizationContext } from "../authorization"
import type { OntologySource } from "../ontology"
import { isBoundSixb, type Sixb } from "../runtime/sixb"
import type { CreateExecutionInput, ExecutionRecord } from "../storage/executions"
import { ExecutionStorageError } from "../storage/executions"
import { createAgentRuntimeAuthorization } from "./authorization"
import type { AuthorizablePrincipal, ExecutionContext, ExecutionScope } from "./types"

/** Minimal host boundary required by agent workers. */
export interface AgentExecutionHost {
  readonly id: string
  withScope(scope: ExecutionScope): object
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

/** Bind a worker to the immutable execution already owned by its durable Agent run. */
export function bindDurableAgentExecution(
  host: AgentExecutionHost,
  input: {
    readonly execution: ExecutionRecord
    readonly agentId: string
    readonly runId: string
    readonly authorization: AuthorizationContext
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
  readonly agentId: string
  readonly runId: string
  readonly authorization: AuthorizationContext
}): ExecutionScope {
  assertAgentExecutionRecord(input)
  const context: ExecutionContext = Object.freeze({
    id: input.execution.id,
    projectId: input.execution.projectId,
    ...(input.execution.requestedBy === undefined
      ? {}
      : { requestedBy: structuredClone(input.execution.requestedBy) }),
    executor: Object.freeze({ type: "agent", agentId: input.agentId, runId: input.runId }),
    source: Object.freeze(structuredClone(input.execution.source)),
    correlationId: input.execution.correlationId,
  })
  return Object.freeze({
    execution: context,
    authorization: createAgentRuntimeAuthorization({
      projectId: input.execution.projectId,
      context: input.authorization,
      executionId: input.execution.id,
      agentId: input.agentId,
      runId: input.runId,
    }),
  })
}

/** Validate that a durable record belongs to the exact resolved Agent execution. */
export function assertAgentExecutionRecord(input: {
  readonly execution: ExecutionRecord
  readonly agentId: string
  readonly runId: string
  readonly authorization: AuthorizationContext
}): void {
  const authority = input.execution.authorizationRef
  if (
    input.execution.executor.type !== "agent" ||
    input.execution.executor.runId !== input.runId ||
    input.execution.source.type !== "execution" ||
    authority.type !== "principal" ||
    authority.principal.type !== "serviceAccount" ||
    input.authorization.principal.type !== "serviceAccount" ||
    authority.principal.id !== input.authorization.principal.id ||
    authority.credential !== undefined
  ) {
    invalidAgentExecution(input.execution.id, input.runId)
  }
  assertAgentPrincipal(input.agentId, authority.principal)
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
