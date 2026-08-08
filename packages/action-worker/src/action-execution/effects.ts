import type { JsonValue } from "@sixb/core"
import { isObjectActionDefinition } from "@sixb/core"
import type { ActionEditCommitResult } from "@sixb/core/internal/actions"
import type { ActionRunRecord } from "@sixb/core/storage"
import { toActionRunFailure } from "../normalize"
import { type BasePhaseContext, requireObjectSubject, toActionRuntimeFacade } from "./context"
import type { LoadedObjectTarget, PhaseExecutionBase, UpdateActiveRun } from "./types"

export async function runEffectsPhase(
  input: PhaseExecutionBase & {
    readonly run: ActionRunRecord
    readonly baseContext: BasePhaseContext
    readonly objectTarget: LoadedObjectTarget | null
    readonly writeback: JsonValue | undefined
    readonly commit: ActionEditCommitResult
    readonly updateActiveRun: UpdateActiveRun
  }
): Promise<ActionRunRecord> {
  if (!input.action.phases.effects) {
    return input.run
  }

  let run = await input.runtime.actionRunsStorage.enterPhase({
    projectId: input.runtime.id,
    id: input.run.id,
    phase: "effects",
  })
  input.updateActiveRun(run)

  try {
    if (isObjectActionDefinition(input.action)) {
      const effects = input.action.phases.effects
      await effects({
        ...input.baseContext,
        subject: requireObjectSubject(input.run.subject, input.action.id),
        sixb: toActionRuntimeFacade(input.runtime),
        writeback: input.writeback,
        commit: input.commit,
      })
    } else {
      const effects = input.action.phases.effects
      await effects({
        ...input.baseContext,
        sixb: toActionRuntimeFacade(input.runtime),
        writeback: input.writeback,
        commit: input.commit,
      })
    }

    run = await input.runtime.actionRunsStorage.recordEffects({
      projectId: input.runtime.id,
      id: input.run.id,
      status: "succeeded",
    })
    input.updateActiveRun(run)
    return run
  } catch (error) {
    const completedAt = new Date()
    const failure = toActionRunFailure(error, "effects", {
      actionId: input.action.id,
      runId: input.run.id,
      at: completedAt,
    })
    run = await input.runtime.actionRunsStorage.recordEffects({
      projectId: input.runtime.id,
      id: input.run.id,
      status: "failed",
      completedAt,
      error: failure,
    })
    input.updateActiveRun(run)
    return run
  }
}
