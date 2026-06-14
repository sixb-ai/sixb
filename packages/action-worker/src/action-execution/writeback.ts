import type { ActionRunRecord, JsonValue } from "@sixb/core"
import { assertJsonValue, cloneJsonValue, isObjectActionDefinition } from "@sixb/core"
import { toActionRunFailure } from "../normalize"
import { type BasePhaseContext, requireObjectTarget, toActionRuntimeFacade } from "./context"
import type {
  LoadedObjectTarget,
  PhaseExecutionBase,
  RuntimePhaseHandler,
  UpdateActiveRun,
} from "./types"

export async function runWritebackPhase(
  input: PhaseExecutionBase & {
    readonly run: ActionRunRecord
    readonly baseContext: BasePhaseContext
    readonly objectTarget: LoadedObjectTarget | null
    readonly updateActiveRun: UpdateActiveRun
  }
): Promise<{ run: ActionRunRecord; value: JsonValue | undefined }> {
  const handler = input.action.phases.writeback as RuntimePhaseHandler | undefined
  if (!handler) {
    return { run: input.run, value: undefined }
  }

  if (input.run.writeback?.status === "succeeded") {
    return { run: input.run, value: input.run.writeback.result ?? null }
  }

  let run = await input.runtime.actionRunsStorage.enterPhase({
    projectId: input.runtime.id,
    id: input.run.id,
    phase: "writeback",
  })
  input.updateActiveRun(run)

  try {
    const rawResult = isObjectActionDefinition(input.action)
      ? await handler({
          ...input.baseContext,
          sixb: toActionRuntimeFacade(input.runtime),
          target: requireObjectTarget(input.objectTarget, input.action.id).snapshot,
        })
      : await handler({ ...input.baseContext, sixb: toActionRuntimeFacade(input.runtime) })
    const result = normalizeWritebackResult(rawResult)
    run = await input.runtime.actionRunsStorage.recordWriteback({
      projectId: input.runtime.id,
      id: input.run.id,
      status: "succeeded",
      result,
    })
    input.updateActiveRun(run)
    return { run, value: result }
  } catch (error) {
    const failure = toActionRunFailure(error, "writeback")
    run = await input.runtime.actionRunsStorage.recordWriteback({
      projectId: input.runtime.id,
      id: input.run.id,
      status: "failed",
      error: failure,
    })
    input.updateActiveRun(run)
    throw error
  }
}

function normalizeWritebackResult(result: unknown): JsonValue {
  if (result === undefined) {
    return null
  }

  assertJsonValue(result, "Action writeback result")
  return cloneJsonValue(result)
}
