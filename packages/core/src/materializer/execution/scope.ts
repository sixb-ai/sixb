import { resolveExecutionScopeAuthorization } from "../../execution/authorization"
import { ensureExecutionRecord, executionRecordInputFromRuntime } from "../../execution/durable"
import type {
  AuthorizablePrincipal,
  ExecutionScope,
  TrustedPrimitiveKind,
} from "../../execution/types"
import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import type { EventExecutor } from "../../materialization/events"
import type {
  CreateExecutionInput,
  ExecutionRecord,
  ExecutionStorage,
} from "../../storage/executions"

/**
 * Who and what a commit and its events are attributed to. Both are copied from the execution, so
 * they are a pure function of `executionId` and never an input the caller chooses.
 */
export interface MaterializerAttribution {
  readonly requestedBy?: AuthorizablePrincipal
  readonly executor: EventExecutor
}

/** Immutable execution metadata attached to one prepared Materializer command. */
export interface MaterializerExecution {
  readonly scope: ExecutionScope
  readonly record: CreateExecutionInput
  readonly executionId: string
  readonly correlationId: string
  readonly attribution: MaterializerAttribution
}

/** Validate the process-local scope before any Materializer read or write is attempted. */
export function prepareMaterializerExecution(
  projectId: string,
  scope: ExecutionScope
): MaterializerExecution {
  resolveExecutionScopeAuthorization(projectId, scope)

  return {
    scope,
    record: executionRecordInputFromRuntime({
      execution: scope.execution,
      runtimeAuthorization: scope.authorization,
    }),
    executionId: scope.execution.id,
    correlationId: scope.execution.correlationId,
    attribution: executionAttribution(scope),
  }
}

function executionAttribution(scope: ExecutionScope): MaterializerAttribution {
  const { requestedBy, executor } = scope.execution
  const attributed = { executor: eventExecutor(executor) }
  if (requestedBy === undefined) return attributed
  return { ...attributed, requestedBy: { type: requestedBy.type, id: requestedBy.id } }
}

/** Drop the process-local Agent actor id: the durable execution does not record it. */
function eventExecutor(executor: ExecutionScope["execution"]["executor"]): EventExecutor {
  switch (executor.type) {
    case "request":
      return { type: "request", requestId: executor.requestId }
    case "primitive":
      return { type: "primitive", kind: executor.kind, id: executor.id, runId: executor.runId }
    case "agent":
      return { type: "agent", runId: executor.runId }
    case "kernel":
      return { type: "kernel", operation: structuredClone(executor.operation) }
  }
}

/** Persist a direct request lazily, or prove that a durable worker restored the exact record. */
export function ensureMaterializerExecution(
  executions: ExecutionStorage,
  execution: MaterializerExecution
): Promise<ExecutionRecord> {
  return ensureExecutionRecord(executions, execution.record)
}

/** Runtime mutations may come from any domain SDK execution except an internal kernel operation. */
export function assertRuntimeMutationExecution(execution: MaterializerExecution): void {
  if (execution.scope.execution.executor.type !== "kernel") return
  throw new MaterializationValidationError(
    `Kernel execution '${execution.executionId}' cannot enter the runtime mutation boundary.`
  )
}

/** Require one internal mutation ingress to belong to its exact trusted primitive run. */
export function assertTrustedPrimitiveMutationExecution(
  execution: MaterializerExecution,
  primitive: {
    readonly kind: TrustedPrimitiveKind
    readonly id: string
    readonly runId: string
  }
): void {
  const executor = execution.scope.execution.executor
  if (
    executor.type === "primitive" &&
    executor.kind === primitive.kind &&
    executor.id === primitive.id &&
    executor.runId === primitive.runId
  ) {
    return
  }
  throw new MaterializationConflictError(
    "run-correlation",
    `Execution '${execution.executionId}' does not own ${primitive.kind} run '${primitive.runId}'.`
  )
}

/** Require the provider-validated run to reference the same immutable execution as the command. */
export function assertMaterializerRunExecution(
  execution: MaterializerExecution,
  runExecutionId: string,
  label: string
): void {
  if (runExecutionId === execution.executionId) return
  throw new MaterializationConflictError(
    "run-correlation",
    `${label} belongs to execution '${runExecutionId}', not '${execution.executionId}'.`
  )
}
