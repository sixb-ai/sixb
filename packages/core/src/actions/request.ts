import { AuthorizationError, assertAuthorized, canViewActionRun } from "../authorization"
import {
  getAuthorizationRef,
  type ResolvedRuntimeAuthorization,
  resolveExecutionScopeAuthorization,
} from "../execution/authorization"
import {
  createPrimitiveExecutionRecord,
  ensureExecutionRecord,
  executionRecordInputFromRuntime,
} from "../execution/durable"
import type { ExecutionContext } from "../execution/types"
import { OntologyValidationError } from "../ontology/errors"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { SixbRuntimeContext } from "../runtime/types"
import { assertParamUsersActive } from "../shared/params/user-refs"
import type { ActionRunRecord } from "../storage"
import {
  assertObjectReadOutputWithinLimit,
  ObjectReadLimitExceededError,
} from "../storage/objects/execution-limits"
import { admitDelegatedObjectAction, assertDelegatedActionTarget } from "./delegated-admission"
import { getActionRunExecutor } from "./run/executor"
import { actionRunBelongsToShareGrant } from "./run-authorization"
import { createActionRunId } from "./run-id"
import { type ExistingActionRun, persistActionRun } from "./run-persistence"
import type { ActionDefinition, ActionSubject } from "./types"
import {
  isObjectActionDefinition,
  normalizeActionParams,
  resolveObjectActionSubject,
  validateActionSubject,
} from "./validation"

export interface RequestActionOptions {
  readonly runId?: string
  /**
   * Cancels the run before its irreversible boundary: a succeeded writeback, or the commit of an
   * Action without one. Past it, the run finishes whatever this signal does.
   */
  readonly signal?: AbortSignal
}

export interface RequestActionInput extends RequestActionOptions {
  readonly actionId: string
  readonly subject?: ActionSubject
  readonly params?: Record<string, unknown>
  /** Called once the run's execution exists, before the run executes. A throw starts nothing. */
  readonly onRequested?: (runId: string) => void | Promise<void>
}

function getActionDefinition(runtime: SixbRuntimeContext, actionId: string): ActionDefinition {
  const action = runtime.actionRegistry.getById(actionId)
  if (!action) {
    throw new OntologyValidationError(`Unknown action '${actionId}'`)
  }
  return action
}

/**
 * Request an Action run and execute it in this process, returning its terminal record.
 *
 * Admission, authorization and params are checked before anything is persisted. A run id that is
 * already recorded returns that run's record, without running it again.
 */
export async function requestAction(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  input: RequestActionInput
): Promise<ActionRunRecord> {
  // Capture the three process-local capabilities before caller-owned request getters can run.
  const projectId = runtime.projectId
  const runtimeAuthorization = runtime.runtimeAuthorization
  const objectReader = runtime.objectReader
  const request = snapshotActionRequest(input)
  const authorization = resolveExecutionScopeAuthorization(projectId, {
    execution,
    authorization: runtimeAuthorization,
  })
  const subject = request.subject
  const delegatedSubject =
    authorization.type === "delegated"
      ? assertDelegatedActionTarget({
          authorization,
          actionId: request.actionId,
          subject,
        })
      : undefined
  const action = getActionDefinition(runtime, request.actionId)
  const actionId = action.id
  const rawParams = request.params

  if (authorization.type === "delegated") {
    await admitDelegatedObjectAction({
      objectReader,
      runtimeAuthorization,
      execution,
      authorization,
      action,
      subject: delegatedSubject!,
    })
  } else {
    assertAuthorized({ projectId, runtimeAuthorization }, { kind: "action.apply", actionId })
  }
  if (authorization.type !== "delegated" && action.binding.kind === "object") {
    // Object actions require visibility of the type they are bound to, as listing them does.
    assertAuthorized(
      { projectId, runtimeAuthorization },
      { kind: "object.view", objectTypeId: action.binding.objectType.id }
    )
  }

  validateActionSubject(action, subject)

  let pathPrefix = action.id
  let objectType: ObjectTypeWithPropertyTokens | null = null

  if (isObjectActionDefinition(action)) {
    objectType = resolveObjectActionSubject({ runtime, action, subject })
    pathPrefix = `${objectType.id}.${action.id}`
    if (authorization.type !== "delegated") {
      // A run is visible to whoever may view its subject's type (`canViewActionRun`). A subtype
      // excluded from a broad grant is not visible through its parent, so admitting the request on
      // the bound type alone would run what its caller can never read back.
      assertAuthorized(
        { projectId, runtimeAuthorization },
        { kind: "object.view", objectTypeId: objectType.id }
      )
    }
  }

  const actionParams = normalizeActionParams(runtime, action.params, rawParams, pathPrefix)
  const runId = createActionRunId(request.runId)

  // `persistActionRun` checks an existing run id before creating its durable execution. Keep
  // process-local delegation outside that oracle unless it carries durable grant provenance.
  void getAuthorizationRef(runtimeAuthorization)
  // A run starts only while its caller still waits for it; an aborted caller gets its abort.
  const executor = getActionRunExecutor(runtime)
  request.signal?.throwIfAborted()

  const payload = { actionId, subject, params: actionParams }
  const assertCanReuse = (run: ExistingActionRun) =>
    assertCallerMayHaveRun({ storage: runtime.storage, projectId, authorization, run })
  const persist = () =>
    persistActionRun({
      projectId,
      storage: runtime.storage,
      runId,
      payload,
      assertCanReuse,
      assertNewRun: () =>
        assertParamUsersActive({
          auth: runtime.storage.auth,
          projectId,
          schemas: Object.fromEntries(
            Object.entries(action.params).map(([paramId, param]) => [paramId, param.schema])
          ),
          values: actionParams,
          valueTypesById: runtime.ontology.getValueTypesById(),
          describe: (paramId) => `Action param '${pathPrefix}.${paramId}'`,
          invalid: (message) => new OntologyValidationError(message),
        }),
      createExecution: async (executionId, runId) => {
        const caller = await ensureExecutionRecord(
          runtime.storage.executions,
          executionRecordInputFromRuntime({
            execution,
            runtimeAuthorization,
          })
        )
        return createPrimitiveExecutionRecord({
          id: executionId,
          primitive: { kind: "action", id: actionId, runId },
          origin: { type: "execution", parent: caller },
        })
      },
    })

  const run = await executor.request({
    runId,
    payload,
    persist,
    assertCanReuse,
    signal: request.signal,
    onRequested: request.onRequested,
  })
  return enforceDelegatedOutputBudget(authorization, run)
}

/**
 * A run that already exists under the requested run id, recorded or executing, answers this request
 * only under the rules that would let its caller read it.
 *
 * A principal gets it under the visibility rules `actions.runs.getById` applies; admission already
 * requires the grants those rules check for the request's own Action and subject, and this keeps a
 * run that carries another request from depending on it. A delegated caller gets it only when it was
 * requested under the same Share grant.
 */
async function assertCallerMayHaveRun(input: {
  readonly storage: SixbRuntimeContext["storage"]
  readonly projectId: string
  readonly authorization: ResolvedRuntimeAuthorization
  readonly run: ExistingActionRun
}): Promise<void> {
  const { authorization, run } = input
  const visible =
    authorization.type === "delegated"
      ? authorization.delegation !== undefined &&
        (await actionRunBelongsToShareGrant({
          storage: input.storage,
          projectId: input.projectId,
          run,
          grantId: authorization.delegation.grantId,
        }))
      : authorization.type !== "principal" || canViewActionRun(authorization.context, run)
  if (!visible) {
    throw new AuthorizationError(
      `apply:action:${run.actionId}`,
      authorization.type === "delegated"
        ? "[Sixb] Delegated authority cannot reuse this Action run."
        : `[Sixb] Action run '${run.id}' is not visible to this principal.`
    )
  }
}

/**
 * A delegated caller receives the record only within its output budget, like any read.
 *
 * The run already ran by then, and its record does not change: requesting the same run id again
 * is refused the same way.
 */
function enforceDelegatedOutputBudget(
  authorization: ResolvedRuntimeAuthorization,
  run: ActionRunRecord
): ActionRunRecord {
  if (authorization.type !== "delegated") return run
  try {
    assertObjectReadOutputWithinLimit(run, authorization.objectRead.limits)
  } catch (error) {
    if (!(error instanceof ObjectReadLimitExceededError)) throw error
    throw new ObjectReadLimitExceededError(
      error.metric,
      error.limit,
      `[Sixb] Action run '${run.id}' finished with status '${run.status}', but its record exceeds ` +
        `this caller's ${error.metric} limit (${error.limit}). Requesting it again returns the ` +
        "same record."
    )
  }
  return run
}

function snapshotActionRequest(input: RequestActionInput): {
  readonly actionId: string
  readonly subject: ActionSubject
  readonly params: Record<string, unknown>
  readonly runId?: string
  readonly signal?: AbortSignal
  readonly onRequested?: (runId: string) => void | Promise<void>
} {
  const actionId = input.actionId
  const subject = input.subject
  const params = input.params
  const runId = input.runId
  const signal = input.signal
  const onRequested = input.onRequested
  return {
    ...structuredClone({
      actionId,
      subject: subject ?? { kind: "none" },
      params: params ?? {},
      ...(runId === undefined ? {} : { runId }),
    }),
    ...(signal === undefined ? {} : { signal }),
    ...(onRequested === undefined ? {} : { onRequested }),
  }
}
