import type { SixbBranch } from "../../branch-mode"
import { reportActionPhaseFailure } from "../../error-reporting/capability"
import type { Logger } from "../../logging"
import { resolveLoggingService } from "../../logging/service"
import type { RecordActionEffectsInput } from "../../storage"
import type { ActionEditCommitResult } from "../commit-edits"
import type { ActionDefinition } from "../types"
import { isObjectActionDefinition } from "../validation"
import { createBasePhaseContext, requireObjectSubject, toActionRuntimeFacade } from "./context"
import { toActionRunFailure, translateActionPhaseError, untilAborted } from "./normalize"
import type { ActionDeadline } from "./signals"
import type { ActionRunState } from "./state"
import type { ActionRunContext } from "./types"

export interface RunActionEffectsInput {
  readonly runtime: ActionRunContext
  readonly action: ActionDefinition
  /** The run, recorded as succeeded with the commit its effects receive. */
  readonly state: ActionRunState
  readonly commit: ActionEditCommitResult
  /** Starts the effects' deadline. */
  readonly startDeadline: () => ActionDeadline
}

/**
 * Run a recorded run's effects and record their outcome on it.
 *
 * Effects run after the run's record is returned, and nothing waits for them but a stopping
 * process. They are best-effort: their failure does not reject this, it is recorded on the run and
 * reported to `onError`, and the run stays succeeded.
 */
export async function runActionEffects(input: RunActionEffectsInput): Promise<void> {
  const { runtime, action, state } = input
  const ids = { actionId: action.id, runId: state.run.id }
  const logSession = resolveLoggingService(runtime.id, runtime.logging).startExecution({
    kind: "action",
    id: state.run.id,
  })
  const deadline = input.startDeadline()

  try {
    const logger = logSession.withContext({ phase: "effects" })
    const outcome = runtime.branch
      ? skipEffects(input, runtime.branch, logger)
      : await callEffects(input, deadline.signal, logger)

    try {
      await runtime.actionRunsStorage.recordEffects(outcome)
    } catch (error) {
      console.error(
        `[Sixb] Action run '${ids.runId}' ran its effects, but their outcome could not be recorded:`,
        error
      )
    }
  } finally {
    deadline.dispose()
    await logSession.flush()
  }
}

/**
 * Effects notify people and systems, and a branch sends nothing: they are recorded as skipped, and
 * the run's logs say why, so the run reads the same as in production but for what it sent.
 */
function skipEffects(
  input: RunActionEffectsInput,
  branch: SixbBranch,
  logger: Logger
): RecordActionEffectsInput {
  logger.info(
    `[Sixb] Branch "${branch.name}": the effects of action '${input.action.id}' were skipped. ` +
      "A branch notifies no one; they run in production."
  )

  return {
    id: input.state.run.id,
    projectId: input.runtime.id,
    status: "skipped",
    completedAt: new Date(),
  }
}

/** Call the effects handler, and describe how it ended. A failure is reported here, once. */
async function callEffects(
  input: RunActionEffectsInput,
  signal: AbortSignal,
  logger: Logger
): Promise<RecordActionEffectsInput> {
  const { runtime, action, state } = input
  const ids = { actionId: action.id, runId: state.run.id }
  const effects = { id: state.run.id, projectId: runtime.id }

  try {
    const context = {
      ...createBasePhaseContext({ runtime, action, state, logger }),
      signal,
      sixb: toActionRuntimeFacade(runtime),
      writeback: state.writebackValue,
      commit: input.commit,
    }
    await untilAborted(async () => {
      if (isObjectActionDefinition(action)) {
        await action.phases.effects?.({
          ...context,
          subject: requireObjectSubject(state.run.subject, ids),
        })
      } else {
        await action.phases.effects?.(context)
      }
    }, signal)
  } catch (error) {
    const completedAt = new Date()
    const failure = toActionRunFailure(
      translateActionPhaseError(error, "effects", { ...ids, signal }),
      "effects",
      { ...ids, at: completedAt }
    )
    reportActionPhaseFailure(runtime.errorReporterHost, error, {
      projectId: runtime.id,
      ...ids,
      phase: "effects",
      failure,
    })
    return { ...effects, status: "failed", completedAt, error: failure }
  }

  return { ...effects, status: "succeeded", completedAt: new Date() }
}
