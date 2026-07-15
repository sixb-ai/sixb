import { isObjectActionDefinition } from "@sixb/core"
import { runActionValidators } from "@sixb/core/internal/actions"
import { resolveLogsRuntime } from "@sixb/core/internal/logging"
import type { ActionRunRecord } from "@sixb/core/storage"
import { throwIfAborted } from "../normalize"
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
  const logSession = resolveLogsRuntime(runtime.id, runtime.logs).startExecution({
    kind: "action",
    id: input.run.id,
  })
  const objectTarget = await loadObjectTarget({ runtime, action, run })
  const phaseContext = createBasePhaseContext({
    runtime,
    action,
    run,
    signal,
    logger: logSession.withContext({ phase: "validation" }),
  })

  try {
    if (!run.writeback && !run.commit) {
      run = await runtime.actionRunsStorage.enterPhase({
        projectId: runtime.id,
        id: run.id,
        phase: "validation",
      })
      input.updateActiveRun(run)
      await runActionValidators({
        action,
        subject: run.subject,
        baseContext: phaseContext,
        target: isObjectActionDefinition(action) ? objectTarget?.snapshot : undefined,
      })
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
      updateActiveRun(run) {
        input.updateActiveRun(run)
      },
    })
    run = writeback.run

    throwIfAborted(signal)

    const commit = await runEditsAndCommitPhase({
      runtime,
      action,
      run,
      signal,
      baseContext: {
        ...phaseContext,
        logger: logSession.withContext({ phase: "edits" }),
      },
      objectTarget,
      writeback: writeback.value,
      updateActiveRun(run) {
        input.updateActiveRun(run)
      },
    })
    run = commit.run

    throwIfAborted(signal)

    if (commit.result && action.phases.effects && !run.effects) {
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
        writeback: writeback.value,
        commit: commit.result,
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
