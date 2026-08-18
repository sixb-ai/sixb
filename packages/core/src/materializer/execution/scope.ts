import type { EventActor } from "../../events/envelope"
import {
  type ResolvedRuntimeAuthorization,
  resolveExecutionScopeAuthorization,
} from "../../execution/authorization"
import { ensureExecutionRecord, executionRecordInputFromRuntime } from "../../execution/durable"
import type { ExecutionScope, TrustedPrimitiveKind } from "../../execution/types"
import {
  MaterializationConflictError,
  MaterializationValidationError,
} from "../../materialization/errors"
import type {
  CreateExecutionInput,
  ExecutionRecord,
  ExecutionStorage,
} from "../../storage/executions"

/** Immutable execution metadata attached to one prepared Materializer command. */
export interface MaterializerExecution {
  readonly scope: ExecutionScope
  readonly record: CreateExecutionInput
  readonly executionId: string
  readonly correlationId: string
  readonly actor?: EventActor
}

/** Validate the process-local scope before any Materializer read or write is attempted. */
export function prepareMaterializerExecution(
  projectId: string,
  scope: ExecutionScope
): MaterializerExecution {
  let authorization: Exclude<ResolvedRuntimeAuthorization, { readonly type: "denied" }>
  try {
    authorization = resolveExecutionScopeAuthorization(projectId, scope)
  } catch (error) {
    throw new MaterializationValidationError(
      error instanceof Error ? error.message : "Materializer execution scope is invalid."
    )
  }

  const base = {
    scope,
    record: executionRecordInputFromRuntime({
      execution: scope.execution,
      runtimeAuthorization: scope.authorization,
    }),
    executionId: scope.execution.id,
    correlationId: scope.execution.correlationId,
  }
  if (authorization.type !== "principal") return base
  return { ...base, actor: authorization.context.principal }
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
