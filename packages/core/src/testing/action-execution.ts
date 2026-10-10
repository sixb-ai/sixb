import type { ActionSubject } from "../actions"
import type { AuthorizablePrincipal, TrustedPrimitiveRef } from "../execution"
import type {
  ActionRunFailure,
  ActionRunParams,
  ActionRunPhase,
  ActionRunRecord,
  ActionRunWritebackRecord,
  RecordActionRunInput,
  Storage,
} from "../storage"
import type { ExecutionStorage } from "../storage/executions"

/** Create the durable execution chain required by an Action-run storage fixture. */
export async function createTestActionExecution(
  executions: ExecutionStorage,
  input: {
    readonly projectId: string
    readonly actionId: string
    readonly runId: string
    readonly executionId?: string
    readonly requesterGroupIds?: readonly string[]
    /** Must name an existing auth principal. The parent request then carries its authority. */
    readonly requestedBy?: AuthorizablePrincipal
  }
): Promise<string> {
  const parentExecutionId = `test_request_execution:${input.runId}`
  const executionId = input.executionId ?? `test_action_execution:${input.runId}`
  const primitive: TrustedPrimitiveRef = {
    kind: "action",
    id: input.actionId,
    runId: input.runId,
  }

  const existing = await executions.getById({ projectId: input.projectId, id: executionId })
  if (existing) return executionId

  const requestedBy = input.requestedBy
  const parent = await executions.getById({ projectId: input.projectId, id: parentExecutionId })
  if (!parent) {
    await executions.create({
      id: parentExecutionId,
      requesterGroupIds: input.requesterGroupIds ?? [],
      projectId: input.projectId,
      ...(requestedBy === undefined ? {} : { requestedBy }),
      executor: { type: "request", requestId: `test_request:${input.runId}` },
      source: { type: "http", requestId: `test_request:${input.runId}` },
      correlationId: `test_correlation:${input.runId}`,
      authorizationRef:
        requestedBy === undefined
          ? { type: "disabled" }
          : { type: "principal", principal: requestedBy },
    })
  }
  await executions.create({
    id: executionId,
    requesterGroupIds: input.requesterGroupIds ?? [],
    projectId: input.projectId,
    ...(requestedBy === undefined ? {} : { requestedBy }),
    executor: { type: "primitive", kind: primitive.kind, runId: primitive.runId },
    source: { type: "execution", executionId: parentExecutionId },
    correlationId: `test_correlation:${input.runId}`,
    authorizationRef: { type: "trustedPrimitive", primitive },
  })

  return executionId
}

type TestActionRunOutcome =
  | { readonly status?: "succeeded"; readonly error?: never }
  | { readonly status: "failed"; readonly error: ActionRunFailure }

/** A test Action run that ended. It succeeds in its commit phase unless told otherwise. */
export type TestActionRunInput = TestActionRunOutcome & {
  readonly id: string
  readonly projectId: string
  readonly actionId: string
  readonly subject: ActionSubject
  readonly params: ActionRunParams
  readonly idempotencyKey: string
  /** Defaults to `commit` for a succeeded run, and to its failure's phase for a failed one. */
  readonly phase?: ActionRunPhase
  /** Defaults to now. */
  readonly startedAt?: Date
  /** Defaults to `startedAt`. */
  readonly finishedAt?: Date
  readonly writeback?: ActionRunWritebackRecord
  readonly requesterGroupIds?: readonly string[]
  /** Must name an existing auth principal. The parent request then carries its authority. */
  readonly requestedBy?: AuthorizablePrincipal
}

/**
 * Create a test run's durable execution, and return the run's terminal record without writing it:
 * an Action commit carries the record it inserts.
 */
export async function createTestActionRunRecord(
  executions: ExecutionStorage,
  input: TestActionRunInput
): Promise<RecordActionRunInput> {
  const executionId = await createTestActionExecution(executions, {
    projectId: input.projectId,
    actionId: input.actionId,
    runId: input.id,
    requesterGroupIds: input.requesterGroupIds,
    ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
  })
  const startedAt = input.startedAt ?? new Date()
  const fields = {
    id: input.id,
    projectId: input.projectId,
    executionId,
    actionId: input.actionId,
    subject: input.subject,
    params: input.params,
    idempotencyKey: input.idempotencyKey,
    startedAt,
    finishedAt: input.finishedAt ?? startedAt,
    ...(input.writeback === undefined ? {} : { writeback: input.writeback }),
  }
  return input.status === "failed"
    ? {
        ...fields,
        status: "failed",
        phase: input.phase ?? input.error.details.phase,
        error: input.error,
      }
    : { ...fields, status: "succeeded", phase: input.phase ?? "commit" }
}

/** Record a test Action run with the valid durable execution every provider requires. */
export async function recordTestActionRun(
  storage: Pick<Storage, "actionRuns" | "executions">,
  input: TestActionRunInput
): Promise<ActionRunRecord> {
  if (!storage.actionRuns) throw new Error("Action run storage is not configured for this test.")
  return storage.actionRuns.record(await createTestActionRunRecord(storage.executions, input))
}
