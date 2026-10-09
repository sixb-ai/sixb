import type { JsonValue } from "../../json"
import { assertJsonValue, cloneJsonValue } from "../../json"
import type { ActionRunRecord } from "../../storage"
import type { ActionReadRecorder } from "../read-facade"
import { isObjectActionDefinition } from "../validation"
import {
  type BasePhaseContext,
  requireObjectTarget,
  toActionReadFacade,
  toActionRuntimeFacade,
} from "./context"
import { toActionRunFailure, translateActionPhaseError } from "./normalize"
import type {
  LoadedObjectTarget,
  PhaseExecutionBase,
  RuntimePhaseHandler,
  UpdateActiveRun,
} from "./phase-types"

export async function runWritebackPhase(
  input: PhaseExecutionBase & {
    readonly run: ActionRunRecord
    readonly baseContext: BasePhaseContext
    readonly objectTarget: LoadedObjectTarget | null
    readonly reads: ActionReadRecorder
    readonly updateActiveRun: UpdateActiveRun
  }
): Promise<{ run: ActionRunRecord; value: JsonValue | undefined }> {
  const handler = input.action.phases.writeback as RuntimePhaseHandler | undefined
  if (!handler) {
    return { run: input.run, value: undefined }
  }

  let run = await input.runtime.actionRunsStorage.enterPhase({
    projectId: input.runtime.id,
    id: input.run.id,
    phase: "writeback",
  })
  input.updateActiveRun(run)

  let result: JsonValue
  try {
    // Reads are side-effect-free, so the writeback phase can safely enrich its external payload
    // before the edit batch exists. Object, link-scope, and returned query/list rows share the
    // edits phase's recorder and are fenced by the same CAS. Query membership and telemetry
    // history remain call-level snapshots.
    const context = {
      ...input.baseContext,
      signal: input.signal,
      sixb: toActionRuntimeFacade(input.runtime),
      read: toActionReadFacade(input.runtime, input.reads),
    }
    const rawResult = isObjectActionDefinition(input.action)
      ? await handler({
          ...context,
          target: requireObjectTarget(input.objectTarget, {
            actionId: input.action.id,
            runId: input.run.id,
          }).snapshot,
        })
      : await handler(context)
    result = normalizeWritebackResult(rawResult)
  } catch (error) {
    const completedAt = new Date()
    const phaseError = translateActionPhaseError(error, "writeback", {
      actionId: input.action.id,
      runId: input.run.id,
      signal: input.signal,
    })
    const failure = toActionRunFailure(phaseError, "writeback", {
      actionId: input.action.id,
      runId: input.run.id,
      at: completedAt,
    })
    run = await input.runtime.actionRunsStorage.recordWriteback({
      projectId: input.runtime.id,
      id: input.run.id,
      status: "failed",
      completedAt,
      error: failure,
    })
    input.updateActiveRun(run)
    throw error
  }

  run = await input.runtime.actionRunsStorage.recordWriteback({
    projectId: input.runtime.id,
    id: input.run.id,
    status: "succeeded",
    result,
  })
  input.updateActiveRun(run)
  return { run, value: result }
}

function normalizeWritebackResult(result: unknown): JsonValue {
  if (result === undefined) {
    return null
  }

  assertJsonValue(result, "Action writeback result")
  return cloneJsonValue(result)
}
