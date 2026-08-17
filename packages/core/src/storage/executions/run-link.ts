import type { TrustedPrimitiveRef } from "../../execution/types"
import type { ExecutionRecord, ExecutionStorage } from "./types"

/**
 * Find the immutable execution that is the authority owned by a primitive run.
 *
 * ExecutionStorage owns generic provenance invariants. Primitive providers remain responsible for
 * deciding which sources they accept and translating a mismatch to their domain-specific error.
 */
export async function findPrimitiveRunExecution(input: {
  readonly executions: ExecutionStorage
  readonly projectId: string
  readonly executionId: string
  readonly primitive: TrustedPrimitiveRef
  readonly sourceTypes: readonly (
    | "datasetVersion"
    | "event"
    | "execution"
    | "schedule"
    | "webhook"
  )[]
}): Promise<ExecutionRecord | null> {
  const execution = await input.executions.getById({
    projectId: input.projectId,
    id: input.executionId,
  })
  const authority = execution?.authorizationRef
  if (
    !execution ||
    !input.sourceTypes.some((type) => type === execution.source.type) ||
    execution.executor.type !== "primitive" ||
    execution.executor.kind !== input.primitive.kind ||
    execution.executor.runId !== input.primitive.runId ||
    authority?.type !== "trustedPrimitive" ||
    authority.primitive.kind !== input.primitive.kind ||
    authority.primitive.id !== input.primitive.id ||
    authority.primitive.runId !== input.primitive.runId
  ) {
    return null
  }
  return execution
}

/** Find the immutable execution and service-account authority owned by one Agent run. */
export async function findAgentRunExecution(input: {
  readonly executions: ExecutionStorage
  readonly projectId: string
  readonly executionId: string
  readonly runId: string
  readonly serviceAccountId: string
}): Promise<ExecutionRecord | null> {
  const execution = await input.executions.getById({
    projectId: input.projectId,
    id: input.executionId,
  })
  const authority = execution?.authorizationRef
  if (
    !execution ||
    execution.source.type !== "execution" ||
    execution.executor.type !== "agent" ||
    execution.executor.runId !== input.runId ||
    authority?.type !== "principal" ||
    authority.principal.type !== "serviceAccount" ||
    authority.principal.id !== input.serviceAccountId ||
    authority.credential !== undefined
  ) {
    return null
  }
  return execution
}
