import type { ActionReadObjectSetSource, JsonValue } from "@sixb/core"
import { assertJsonValue, cloneJsonValue, isObjectActionDefinition } from "@sixb/core"
import type { ActionReadRecorder } from "@sixb/core/internal/actions"
import { createActionReadFacade } from "@sixb/core/internal/actions"
import type { ActionRunRecord } from "@sixb/core/storage"
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
    readonly reads: ActionReadRecorder
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
    // Reads are side-effect-free, so the writeback phase can safely enrich its
    // external payload from related objects (links, traversals) before the edit
    // batch exists. They share the edits phase's recorder, so a decision made here
    // against state that changed before the commit is caught by the same CAS.
    const read = createActionReadFacade(
      (objectType) => input.runtime.sixb.objects(objectType) as ActionReadObjectSetSource,
      {
        recorder: input.reads,
        resolveLinkIds: (objectTypeId) =>
          input.runtime.sixb.objects
            .resolveType(objectTypeId)
            .links.map((definition) => definition.id),
      }
    )
    const rawResult = isObjectActionDefinition(input.action)
      ? await handler({
          ...input.baseContext,
          sixb: toActionRuntimeFacade(input.runtime),
          read,
          target: requireObjectTarget(input.objectTarget, {
            actionId: input.action.id,
            runId: input.run.id,
          }).snapshot,
        })
      : await handler({ ...input.baseContext, sixb: toActionRuntimeFacade(input.runtime), read })
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
    const completedAt = new Date()
    const failure = toActionRunFailure(error, "writeback", {
      actionId: input.action.id,
      runId: input.run.id,
      at: completedAt,
    })
    run = await input.runtime.actionRunsStorage.recordWriteback({
      projectId: input.runtime.id,
      id: input.run.id,
      status: "failed",
      completedAt,
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
