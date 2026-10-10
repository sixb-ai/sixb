import type { JsonValue } from "../../json"
import { assertJsonValue, cloneJsonValue } from "../../json"
import type { ActionReadRecorder } from "../read-facade"
import { isObjectActionDefinition } from "../validation"
import {
  type BasePhaseContext,
  requireObjectTarget,
  toActionReadFacade,
  toActionRuntimeFacade,
} from "./context"
import { toActionRunFailure, translateActionPhaseError } from "./normalize"
import type { LoadedObjectTarget, PhaseExecutionBase, RuntimePhaseHandler } from "./phase-types"
import type { ActionRunState } from "./state"

/**
 * Calls the Action's writeback, when it has one, and keeps how it ended on the run's state.
 *
 * A failed writeback fails the run with the writeback's own failure; a succeeded one is the run's
 * irreversible boundary.
 */
export async function runWritebackPhase(
  input: PhaseExecutionBase & {
    readonly state: ActionRunState
    readonly baseContext: BasePhaseContext
    readonly objectTarget: LoadedObjectTarget | null
    readonly reads: ActionReadRecorder
  }
): Promise<void> {
  const handler = input.action.phases.writeback as RuntimePhaseHandler | undefined
  if (!handler) return

  const { state } = input
  const ids = { actionId: input.action.id, runId: state.run.id }
  state.enter("writeback")

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
          target: requireObjectTarget(input.objectTarget, ids).snapshot,
        })
      : await handler(context)
    result = normalizeWritebackResult(rawResult)
  } catch (error) {
    const completedAt = new Date()
    const phaseError = translateActionPhaseError(error, "writeback", {
      ...ids,
      signal: input.signal,
    })
    state.recordWriteback({
      status: "failed",
      completedAt,
      error: toActionRunFailure(phaseError, "writeback", { ...ids, at: completedAt }),
    })
    throw error
  }

  state.recordWriteback({ status: "succeeded", completedAt: new Date(), result })
}

function normalizeWritebackResult(result: unknown): JsonValue {
  if (result === undefined) {
    return null
  }

  assertJsonValue(result, "Action writeback result")
  return cloneJsonValue(result)
}
