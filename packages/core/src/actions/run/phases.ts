import { isSixbError } from "../../errors/internal"
import { resolveLoggingService } from "../../logging/service"
import { ActionReadRecorder } from "../read-facade"
import type { ActionDefinition } from "../types"
import { isObjectActionDefinition } from "../validation"
import { runActionValidators } from "../validators"
import { createBasePhaseContext, loadObjectTarget } from "./context"
import { type CommittedActionRun, runEditsAndCommitPhase } from "./edits-commit"
import { throwIfAborted, translateActionPhaseError } from "./normalize"
import type { ActionRunSignals } from "./signals"
import type { ActionRunState } from "./state"
import type { ActionRunContext } from "./types"
import { runWritebackPhase } from "./writeback"

/** Commits a run attempts before a read conflict fails it. */
const MAX_COMMIT_ATTEMPTS = 3

type LogSession = ReturnType<ReturnType<typeof resolveLoggingService>["startExecution"]>

interface PhasesInput {
  readonly runtime: ActionRunContext
  readonly action: ActionDefinition
  readonly state: ActionRunState
  readonly signals: ActionRunSignals
}

/**
 * Run the phases up to the commit, keeping what they do on the run's state.
 *
 * Resolves with the commit, which recorded the run, for an Action with edits; and with `null` for
 * one without, whose run is still to record. Rejects when a phase fails.
 */
export async function executeActionPhases(input: PhasesInput): Promise<CommittedActionRun | null> {
  const logSession = resolveLoggingService(input.runtime.id, input.runtime.logging).startExecution({
    kind: "action",
    id: input.state.run.id,
  })

  try {
    return await commitWithReplay({ ...input, logSession })
  } finally {
    await logSession.flush()
  }
}

/**
 * Runs the phases up to the commit, and replays them when the commit hits a read conflict.
 *
 * Before the boundary nothing irreversible happened, so the run restarts from validation against
 * current state while its deadline allows. After a succeeded writeback only edits and commit replay,
 * with the same writeback value: the external change happened, and the ontology must still record
 * it.
 */
async function commitWithReplay(
  input: PhasesInput & { readonly logSession: LogSession }
): Promise<CommittedActionRun | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await commitOnce(input)
    } catch (error) {
      const replayable =
        isReadConflict(error) &&
        attempt < MAX_COMMIT_ATTEMPTS &&
        (hasSucceededWriteback(input.state) || !input.signals.beforeBoundary.aborted)
      if (!replayable) throw error
    }
  }
}

async function commitOnce(
  input: PhasesInput & { readonly logSession: LogSession }
): Promise<CommittedActionRun | null> {
  const { runtime, action, state, signals, logSession } = input
  const ids = { actionId: action.id, runId: state.run.id }
  const replayingEdits = hasSucceededWriteback(state)
  const signal = replayingEdits ? signals.uninterruptible : signals.beforeBoundary

  throwIfAborted(signal)

  // Each attempt reads afresh, the subject included: a replay must observe the state that made the
  // previous commit conflict, and fence the commit against that state alone.
  const reads = new ActionReadRecorder()
  let objectTarget: Awaited<ReturnType<typeof loadObjectTarget>>
  try {
    objectTarget = await loadObjectTarget({ runtime, action, run: state.run })
  } catch (error) {
    throw translateActionPhaseError(error, replayingEdits ? "edits" : "validation", {
      ...ids,
      signal,
    })
  }
  const baseContext = createBasePhaseContext({
    runtime,
    action,
    state,
    logger: logSession.withContext({ phase: "validation" }),
  })

  if (!replayingEdits) {
    state.enter("validation")
    try {
      await runActionValidators({
        action,
        subject: state.run.subject,
        baseContext: { ...baseContext, signal },
        target: isObjectActionDefinition(action) ? objectTarget?.snapshot : undefined,
      })
    } catch (error) {
      throw translateActionPhaseError(error, "validation", { ...ids, signal })
    }

    throwIfAborted(signal)
    await runWritebackPhase({
      runtime,
      action,
      state,
      signal,
      baseContext: { ...baseContext, logger: logSession.withContext({ phase: "writeback" }) },
      objectTarget,
      reads,
    })
  }

  // A succeeded writeback is the boundary: from here on, edits and commit always finish.
  const editsSignal = hasSucceededWriteback(state) ? signals.uninterruptible : signal
  throwIfAborted(editsSignal)
  return runEditsAndCommitPhase({
    runtime,
    action,
    state,
    signal: editsSignal,
    baseContext: { ...baseContext, logger: logSession.withContext({ phase: "edits" }) },
    objectTarget,
    reads,
  })
}

function hasSucceededWriteback(state: ActionRunState): boolean {
  return state.writeback?.status === "succeeded"
}

function isReadConflict(error: unknown): boolean {
  return isSixbError(error) && error.code === "action.read_conflict"
}
