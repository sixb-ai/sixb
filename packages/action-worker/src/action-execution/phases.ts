import { isObjectActionDefinition } from "@sixb/core"
import {
  ActionReadRecorder,
  findActionEditCommit,
  runActionValidators,
} from "@sixb/core/internal/actions"
import { resolveLoggingService } from "@sixb/core/internal/logging"
import type { ActionRunRecord } from "@sixb/core/storage"
import { throwIfAborted, translateActionPhaseError } from "../normalize"
import { createBasePhaseContext, loadObjectTarget } from "./context"
import { runEditsAndCommitPhase } from "./edits-commit"
import { runEffectsPhase } from "./effects"
import type { PhaseExecutionBase, UpdateActiveRun } from "./types"
import { runWritebackPhase } from "./writeback"

export async function executeActionPhases(
  input: PhaseExecutionBase & {
    readonly run: ActionRunRecord
    readonly updateActiveRun: UpdateActiveRun
  }
): Promise<ActionRunRecord> {
  const { runtime, action, signal } = input
  let run = input.run
  const logSession = resolveLoggingService(runtime.id, runtime.logging).startExecution({
    kind: "action",
    id: input.run.id,
  })
  // Resolving the authoritative commit once decides both whether validation reruns and whether the
  // subject must still be loaded. A committed Action may have deleted its own subject, so resume
  // must not depend on that object remaining effective.
  const existingCommit = await findActionEditCommit({
    storage: runtime.storage,
    projectId: runtime.id,
    runId: run.id,
  })
  let objectTarget: Awaited<ReturnType<typeof loadObjectTarget>> | null
  try {
    objectTarget = existingCommit ? null : await loadObjectTarget({ runtime, action, run })
  } catch (error) {
    throw translateActionPhaseError(error, "validation", {
      actionId: action.id,
      runId: run.id,
      signal,
    })
  }
  const phaseContext = createBasePhaseContext({
    runtime,
    action,
    run,
    signal,
    logger: logSession.withContext({ phase: "validation" }),
  })
  // One recorder spans writeback and edits: a writeback handler that reads state, calls an external
  // system, and then commits must fail if that state changed while the external call was in flight.
  const reads = new ActionReadRecorder()

  try {
    const resumed = existingCommit
      ? { run, writeback: run.writeback?.result, commit: existingCommit }
      : await executePreCommitPhases({
          ...input,
          run,
          objectTarget,
          phaseContext,
          reads,
          logSession,
        })
    run = resumed.run

    throwIfAborted(signal)

    if (resumed.commit && action.phases.effects && !run.effects) {
      run = await runEffectsPhase({
        runtime,
        action,
        run,
        signal,
        baseContext: {
          ...phaseContext,
          logger: logSession.withContext({ phase: "effects" }),
        },
        objectTarget,
        writeback: resumed.writeback,
        commit: resumed.commit,
        updateActiveRun(run) {
          input.updateActiveRun(run)
        },
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

async function executePreCommitPhases(
  input: PhaseExecutionBase & {
    readonly run: ActionRunRecord
    readonly updateActiveRun: UpdateActiveRun
    readonly objectTarget: Awaited<ReturnType<typeof loadObjectTarget>>
    readonly phaseContext: ReturnType<typeof createBasePhaseContext>
    readonly reads: ActionReadRecorder
    readonly logSession: ReturnType<ReturnType<typeof resolveLoggingService>["startExecution"]>
  }
) {
  const { runtime, action, signal, objectTarget, phaseContext, reads, logSession } = input
  let run = input.run
  if (!run.writeback) {
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
        baseContext: phaseContext,
        target: isObjectActionDefinition(action) ? objectTarget?.snapshot : undefined,
      })
    } catch (error) {
      throw translateActionPhaseError(error, "validation", {
        actionId: action.id,
        runId: run.id,
        signal,
      })
    }
  }

  throwIfAborted(signal)
  const writeback = await runWritebackPhase({
    runtime,
    action,
    run,
    signal,
    baseContext: {
      ...phaseContext,
      logger: logSession.withContext({ phase: "writeback" }),
    },
    objectTarget,
    reads,
    updateActiveRun: input.updateActiveRun,
  })

  throwIfAborted(signal)
  const committed = await runEditsAndCommitPhase({
    runtime,
    action,
    run: writeback.run,
    signal,
    baseContext: {
      ...phaseContext,
      logger: logSession.withContext({ phase: "edits" }),
    },
    objectTarget,
    writeback: writeback.value,
    existingCommit: null,
    reads,
    updateActiveRun: input.updateActiveRun,
  })
  return { run: committed.run, writeback: writeback.value, commit: committed.result }
}
