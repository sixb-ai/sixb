import type { ActionRunRecord, EditCommitResult, JsonValue } from "@sixb/core"
import { isObjectActionDefinition } from "@sixb/core"
import { toActionRunFailure } from "../normalize"
import { type BasePhaseContext, requireObjectSubject, toActionRuntimeFacade } from "./context"
import type { LoadedObjectTarget, PhaseExecutionBase, UpdateActiveRun } from "./types"

export async function runEffectsPhase(
  input: PhaseExecutionBase & {
    readonly run: ActionRunRecord
    readonly baseContext: BasePhaseContext
    readonly objectTarget: LoadedObjectTarget | null
    readonly writeback: JsonValue | undefined
    readonly commit: EditCommitResult
    readonly updateActiveRun: UpdateActiveRun
  }
): Promise<ActionRunRecord> {
  let run = await input.runtime.actionRunsStorage.enterPhase({
    projectId: input.runtime.id,
    id: input.run.id,
    phase: "effects",
  })
  input.updateActiveRun(run)

  try {
    if (!input.action.phases.effects) {
      return run
    }

    if (isObjectActionDefinition(input.action)) {
      await input.action.phases.effects({
        ...input.baseContext,
        subject: requireObjectSubject(input.run.subject, input.action.id),
        sixb: toActionRuntimeFacade(input.runtime),
        writeback: input.writeback,
        commit: input.commit,
      })
    } else {
      await input.action.phases.effects({
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
    const failure = toActionRunFailure(error, "effects")
    run = await input.runtime.actionRunsStorage.recordEffects({
      projectId: input.runtime.id,
      id: input.run.id,
      status: "failed",
      error: failure,
    })
    input.updateActiveRun(run)
    return run
  }
}
