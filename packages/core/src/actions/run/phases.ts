import { isSixbError } from "../../errors/internal"
import type { JsonValue } from "../../json"
import { resolveLoggingService } from "../../logging/service"
import type { ActionRunRecord } from "../../storage"
import { type ActionEditCommitResult, findActionEditCommit } from "../commit-edits"
import { ActionReadRecorder } from "../read-facade"
import type { ActionDefinition } from "../types"
import { isObjectActionDefinition } from "../validation"
import { runActionValidators } from "../validators"
import { createBasePhaseContext, loadObjectTarget } from "./context"
import { runEditsAndCommitPhase } from "./edits-commit"
import { runEffectsPhase } from "./effects"
import { throwIfAborted, translateActionPhaseError } from "./normalize"
import type { UpdateActiveRun } from "./phase-types"
import type { ActionRunSignals } from "./signals"
import type { ActionRunContext } from "./types"
import { runWritebackPhase } from "./writeback"

/** Commits a run attempts before a read conflict fails it. */
const MAX_COMMIT_ATTEMPTS = 3

type LogSession = ReturnType<ReturnType<typeof resolveLoggingService>["startExecution"]>

interface PhasesInput {
  readonly runtime: ActionRunContext
  readonly action: ActionDefinition
  readonly run: ActionRunRecord
  readonly signals: ActionRunSignals
  readonly updateActiveRun: UpdateActiveRun
}

interface CommittedRun {
  readonly run: ActionRunRecord
  readonly writeback: JsonValue | undefined
  readonly commit: ActionEditCommitResult | null
}

/**
 * Whether the run's deadline and caller no longer apply to it.
 *
 * True once its writeback succeeded, or once its commit started for an Action without one: from
 * there the run either commits or fails on its own merits.
 */
export function isPastBoundary(run: ActionRunRecord | null): boolean {
  if (!run) return false
  return hasSucceededWriteback(run) || run.phase === "commit" || run.phase === "effects"
}

export async function executeActionPhases(input: PhasesInput): Promise<ActionRunRecord> {
  const { runtime, action, signals } = input
  const logSession = resolveLoggingService(runtime.id, runtime.logging).startExecution({
    kind: "action",
    id: input.run.id,
  })

  try {
    // Resume past an authoritative commit without depending on the subject: a committed Action may
    // have deleted it.
    const existingCommit = await findActionEditCommit({
      storage: runtime.storage,
      projectId: runtime.id,
      runId: input.run.id,
    })
    const committed: CommittedRun = existingCommit
      ? { run: input.run, writeback: writebackValue(input.run), commit: existingCommit }
      : await commitWithReplay({ ...input, logSession })
    let run = committed.run

    if (committed.commit && action.phases.effects && !run.effects) {
      run = await runEffectsPhase({
        runtime,
        action,
        run,
        signal: signals.startEffects(),
        baseContext: createBasePhaseContext({
          runtime,
          action,
          run,
          logger: logSession.withContext({ phase: "effects" }),
        }),
        writeback: committed.writeback,
        commit: committed.commit,
        updateActiveRun: input.updateActiveRun,
      })
    }

    return await runtime.actionRunsStorage.finish({
      projectId: runtime.id,
      id: run.id,
      status: "succeeded",
    })
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
): Promise<CommittedRun> {
  let latest = input.run
  const updateActiveRun: UpdateActiveRun = (run) => {
    latest = run
    input.updateActiveRun(run)
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await commitOnce({ ...input, run: latest, updateActiveRun })
    } catch (error) {
      const replayable =
        isReadConflict(error) &&
        attempt < MAX_COMMIT_ATTEMPTS &&
        (hasSucceededWriteback(latest) || !input.signals.beforeBoundary.aborted)
      if (!replayable) throw error
    }
  }
}

async function commitOnce(
  input: PhasesInput & { readonly logSession: LogSession }
): Promise<CommittedRun> {
  const { runtime, action, signals, logSession } = input
  let run = input.run
  const ids = { actionId: action.id, runId: run.id }
  const replayingEdits = hasSucceededWriteback(run)
  const signal = replayingEdits ? signals.uninterruptible : signals.beforeBoundary

  throwIfAborted(signal)

  // Each attempt reads afresh, the subject included: a replay must observe the state that made the
  // previous commit conflict, and fence the commit against that state alone.
  const reads = new ActionReadRecorder()
  let objectTarget: Awaited<ReturnType<typeof loadObjectTarget>>
  try {
    objectTarget = await loadObjectTarget({ runtime, action, run })
  } catch (error) {
    throw translateActionPhaseError(error, replayingEdits ? "edits" : "validation", {
      ...ids,
      signal,
    })
  }
  const baseContext = createBasePhaseContext({
    runtime,
    action,
    run,
    logger: logSession.withContext({ phase: "validation" }),
  })

  if (!replayingEdits) {
    run = await runtime.actionRunsStorage.enterPhase({
      projectId: runtime.id,
      id: run.id,
      phase: "validation",
    })
    input.updateActiveRun(run)
    try {
      await runActionValidators({
        action,
        subject: run.subject,
        baseContext: { ...baseContext, signal },
        target: isObjectActionDefinition(action) ? objectTarget?.snapshot : undefined,
      })
    } catch (error) {
      throw translateActionPhaseError(error, "validation", { ...ids, signal })
    }

    throwIfAborted(signal)
    const writeback = await runWritebackPhase({
      runtime,
      action,
      run,
      signal,
      baseContext: { ...baseContext, logger: logSession.withContext({ phase: "writeback" }) },
      objectTarget,
      reads,
      updateActiveRun: input.updateActiveRun,
    })
    run = writeback.run
  }

  // A succeeded writeback is the boundary: from here on, edits and commit always finish.
  const editsSignal = hasSucceededWriteback(run) ? signals.uninterruptible : signal
  throwIfAborted(editsSignal)
  const committed = await runEditsAndCommitPhase({
    runtime,
    action,
    run,
    signal: editsSignal,
    baseContext: { ...baseContext, logger: logSession.withContext({ phase: "edits" }) },
    objectTarget,
    writeback: writebackValue(run),
    existingCommit: null,
    reads,
    updateActiveRun: input.updateActiveRun,
  })
  return { run: committed.run, writeback: writebackValue(run), commit: committed.result }
}

function hasSucceededWriteback(run: ActionRunRecord): boolean {
  return run.writeback?.status === "succeeded"
}

function writebackValue(run: ActionRunRecord): JsonValue | undefined {
  return run.writeback?.status === "succeeded" ? run.writeback.result : undefined
}

function isReadConflict(error: unknown): boolean {
  return isSixbError(error) && error.code === "action.read_conflict"
}
