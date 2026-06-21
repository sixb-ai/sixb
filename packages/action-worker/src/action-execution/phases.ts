import type { ActionRunRecord } from "@sixb/core"
import { throwIfAborted } from "../normalize"
import { createBasePhaseContext, loadObjectTarget } from "./context"
import { runEditsAndCommitPhase } from "./edits-commit"
import { runEffectsPhase } from "./effects"
import type { PhaseExecutionBase, UpdateActiveRun } from "./types"
import { runValidators } from "./validation"
import { runWritebackPhase } from "./writeback"

export async function executeActionPhases(
  input: PhaseExecutionBase & {
    readonly run: ActionRunRecord
    readonly updateActiveRun: UpdateActiveRun
  }
): Promise<ActionRunRecord> {
  const { runtime, action, signal } = input
  let run = input.run
  const objectTarget = await loadObjectTarget({ runtime, action, run })
  const phaseContext = createBasePhaseContext({ runtime, action, run, signal })

  if (!run.writeback && !run.commit) {
    run = await runtime.actionRunsStorage.enterPhase({
      projectId: runtime.id,
      id: run.id,
      phase: "validation",
    })
    input.updateActiveRun(run)
    await runValidators({ action, run, baseContext: phaseContext, objectTarget })
  }

  throwIfAborted(signal)

  const writeback = await runWritebackPhase({
    runtime,
    action,
    run,
    signal,
    baseContext: phaseContext,
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
    baseContext: phaseContext,
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
      baseContext: phaseContext,
      objectTarget,
      writeback: writeback.value,
      commit: commit.result,
      updateActiveRun(run) {
        input.updateActiveRun(run)
      },
    })
  }

  return runtime.actionRunsStorage.finish({
    projectId: runtime.id,
    id: run.id,
    status: "succeeded",
  })
}
