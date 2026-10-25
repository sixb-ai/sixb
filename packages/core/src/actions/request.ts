import { AuthorizationError, assertAuthorized } from "../authorization"
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
import type { ObjectRef } from "../ontology"
import { OntologyValidationError } from "../ontology/errors"
import { isObjectRefSchema } from "../ontology/refs"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { SixbRuntimeContext } from "../runtime/types"
import { assertParamUsersActive } from "../shared/params/user-refs"
import { type ActionRunRecord, ObjectNotFoundError, objectBatchKey } from "../storage"
import type { ActionRunParams } from "../storage/action-runs/types"
import {
  assertObjectReadOutputWithinLimit,
  ObjectReadLimitExceededError,
} from "../storage/objects/execution-limits"
import { admitDelegatedObjectAction, assertDelegatedActionTarget } from "./delegated-admission"
import { getActionRunExecutor } from "./run/executor"
import {
  actionRunBelongsToShareGrant,
  canReadActionRunSubject,
  viewableActionRuns,
} from "./run-authorization"
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
  const admitted = await admitActionRequest(runtime, execution, input)
  const { projectId, runtimeAuthorization, objectReader, authorization, request } = admitted
  const { action, subject, pathPrefix, actionParams } = admitted
  const actionId = action.id
  const runId = createActionRunId(request.runId)

  // `persistActionRun` checks an existing run id before creating its durable execution. Keep
  // process-local delegation outside that oracle unless it carries durable grant provenance.
  void getAuthorizationRef(runtimeAuthorization)
  // A run starts only while its caller still waits for it; an aborted caller gets its abort.
  const executor = getActionRunExecutor(runtime)
  request.signal?.throwIfAborted()

  const payload = { actionId, subject, params: actionParams }
  const assertCanReuse = (run: ExistingActionRun) =>
    assertCallerMayHaveRun({
      storage: runtime.storage,
      projectId,
      authorization,
      objectReader,
      run,
    })
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

  // The request saw its subject; the run reads it again, and must find a state its requester sees.
  const conditioned =
    authorization.type === "principal" &&
    subject.kind === "object" &&
    objectReader.viewsThroughCondition(subject.objectTypeId)

  const run = await executor.request({
    runId,
    payload,
    persist,
    assertCanReuse,
    signal: request.signal,
    onRequested: request.onRequested,
    ...(conditioned
      ? {
          readSubjectAsRequester: ({ objectTypeId, primaryId }) =>
            objectReader.getByPrimaryId({ objectTypeId, primaryId }),
        }
      : {}),
  })
  return enforceDelegatedOutputBudget(authorization, run)
}

/** An Action request as it would run: admitted, and its params normalized. */
export interface PreparedActionRequest {
  readonly actionId: string
  readonly subject: ActionSubject
  readonly params: ActionRunParams
  /** `external` when the Action has a writeback or effects: it reaches beyond Sixb. */
  readonly effect: "ontology" | "external"
}

/**
 * Admit an Action request without running it: the checks and the params `requestAction` applies
 * before anything is persisted. The agent API gateway prepares the calls it holds for approval.
 */
export async function prepareActionRequest(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  input: Pick<RequestActionInput, "actionId" | "subject" | "params">
): Promise<PreparedActionRequest> {
  const { action, subject, actionParams } = await admitActionRequest(runtime, execution, input)

  return {
    actionId: action.id,
    subject,
    params: actionParams,
    effect:
      action.phases.writeback !== undefined || action.phases.effects !== undefined
        ? "external"
        : "ontology",
  }
}

/**
 * Who may request the Action on this subject, and its normalized params, with the capabilities the
 * request runs with. Persists nothing.
 */
async function admitActionRequest(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  input: RequestActionInput
) {
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
    assertAuthorized(
      { projectId, runtimeAuthorization },
      { kind: "action.apply", actionId: action.id }
    )
  }
  if (authorization.type !== "delegated" && action.binding.kind === "object") {
    // Object actions require visibility of the type they are bound to, as listing them does.
    await assertTypeViewable({
      projectId,
      runtimeAuthorization,
      objectReader,
      objectTypeId: action.binding.objectType.id,
    })
  }

  validateActionSubject(action, subject)

  let pathPrefix = action.id
  if (isObjectActionDefinition(action)) {
    const objectType: ObjectTypeWithPropertyTokens = resolveObjectActionSubject({
      runtime,
      action,
      subject,
    })
    pathPrefix = `${objectType.id}.${action.id}`
  }

  const actionParams = normalizeActionParams(runtime, action.params, rawParams, pathPrefix)

  if (authorization.type !== "delegated") {
    await assertNamedObjectsVisible({
      objectReader,
      subject,
      paramsConfig: action.params,
      params: actionParams,
      pathPrefix,
    })
  }

  return {
    projectId,
    runtimeAuthorization,
    objectReader,
    authorization,
    request,
    action,
    subject,
    pathPrefix,
    actionParams,
  }
}

/**
 * A principal views a type whole, through a view grant, or through a condition its reader applies.
 * Only the reader knows the latter, and each object the request names is then read through it.
 */
async function assertTypeViewable(input: {
  readonly projectId: string
  readonly runtimeAuthorization: SixbRuntimeContext["runtimeAuthorization"]
  readonly objectReader: SixbRuntimeContext["objectReader"]
  readonly objectTypeId: string
}): Promise<void> {
  const { objectReader, objectTypeId } = input

  if (objectReader.viewsThroughCondition(objectTypeId)) {
    await objectReader.assertViewable([objectTypeId])
    return
  }

  assertAuthorized(input, { kind: "object.view", objectTypeId })
}

/**
 * A principal acts only on the objects it can see: the action runs as trusted code, so it cannot
 * name, as its subject or a `ref()` param, an object it could not read itself. Each one's type must
 * be viewable as a read requires it, its markings included. A subtype excluded from a broad grant
 * is not viewable through its parent, and a run on it is one its caller could never read back.
 *
 * Where it views a type through a condition, each object of that type must also be visible through
 * its reader now: one that is not is hidden or missing, and both are not found, before anything is
 * recorded. An object of a type it views whole is not read here. Its missing subject fails the run,
 * and its `ref()` params are not looked up, as before conditions existed.
 */
async function assertNamedObjectsVisible(input: {
  readonly objectReader: SixbRuntimeContext["objectReader"]
  readonly subject: ActionSubject
  readonly paramsConfig: ActionDefinition["params"]
  readonly params: Record<string, unknown>
  readonly pathPrefix: string
}): Promise<void> {
  const { objectReader, subject, params } = input

  const named: { readonly ref: ObjectRef; readonly context: string }[] = []
  if (subject.kind === "object") {
    named.push({ ref: subject, context: "Object not found for action run" })
  }
  for (const [paramId, param] of Object.entries(input.paramsConfig)) {
    const value = params[paramId]
    if (!isObjectRefSchema(param.schema) || value === undefined || value === null) continue

    named.push({
      ref: value as ObjectRef,
      context: `Object not found for action param '${input.pathPrefix}.${paramId}'`,
    })
  }

  if (named.length === 0) return
  await objectReader.assertViewable(named.map(({ ref }) => ref.objectTypeId))

  const conditioned = named.filter(({ ref }) =>
    objectReader.viewsThroughCondition(ref.objectTypeId)
  )
  if (conditioned.length === 0) return

  const visible = await objectReader.getByPrimaryIdBatch({
    items: conditioned.map(({ ref }) => ({
      objectTypeId: ref.objectTypeId,
      primaryId: ref.primaryId,
    })),
  })

  for (const { ref, context } of conditioned) {
    if (visible.has(objectBatchKey(ref.objectTypeId, ref.primaryId))) continue
    throw new ObjectNotFoundError(ref.objectTypeId, ref.primaryId, context)
  }
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
  readonly objectReader: SixbRuntimeContext["objectReader"]
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
      : authorization.type !== "principal" ||
        ((await viewableActionRuns(input.objectReader, authorization.context, [run])).length > 0 &&
          (await canReadActionRunSubject(input.objectReader, run)))
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
