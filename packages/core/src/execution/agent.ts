import { agentServiceAccountId } from "../agents/authority"
import { MAIN_AGENT_ID } from "../agents/main-agent"
import { principalsEqual } from "../auth/types"
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
  /** The agent's own managed identity, or the human the run acts for. */
  readonly principal: AuthorizablePrincipal
}): CreateExecutionInput {
  assertAgentExecutionAuthority({
    agentId: input.agentId,
    principal: input.principal,
    requestedBy: input.parent.requestedBy,
  })
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
      : { requestedBy: Object.freeze(structuredClone(input.execution.requestedBy)) }),
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
    !principalsEqual(authority.principal, input.authorization.principal) ||
    authority.credential !== undefined
  ) {
    invalidAgentExecution(input.execution.id, input.runId)
  }
  assertAgentExecutionAuthority({
    agentId: input.agentId,
    principal: authority.principal,
    requestedBy: input.execution.requestedBy,
  })
}

/**
 * An Agent run acts under exactly one of two identities.
 *
 * Its own managed service account is the default. The alternative is **delegated authority**: the
 * run acts as the human who requested it, which is how a framework-managed main agent reaches only
 * what its user can reach without being given groups of its own. Pinning the delegated form to
 * `requestedBy` makes the record self-describing — no extra column, and a run cannot name an
 * identity nobody granted it.
 *
 * The delegated form is restricted to the main agent here rather than only at the call site that
 * mints it, so no future producer — a workflow node, a retry path, a third-party storage seed —
 * can put an authored agent under a human's identity and still pass every layer of validation.
 */
function assertAgentExecutionAuthority(input: {
  readonly agentId: string
  readonly principal: AuthorizablePrincipal
  readonly requestedBy: AuthorizablePrincipal | undefined
}): void {
  const expectedId = agentServiceAccountId(input.agentId)
  if (input.principal.type === "serviceAccount" && input.principal.id === expectedId) {
    return
  }
  if (
    input.agentId === MAIN_AGENT_ID &&
    input.requestedBy &&
    principalsEqual(input.principal, input.requestedBy)
  ) {
    return
  }
  throw new ExecutionStorageError(
    "invalid_input",
    `[Sixb] Agent '${input.agentId}' execution authority must reference service account '${expectedId}' or its requested-by principal.`
  )
}

function invalidAgentExecution(executionId: string, runId: string): never {
  throw new ExecutionStorageError(
    "invalid_input",
    `[Sixb] Execution '${executionId}' does not authorize Agent run '${runId}'.`
  )
}
