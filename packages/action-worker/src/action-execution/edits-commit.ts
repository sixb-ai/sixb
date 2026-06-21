import type {
  ActionEditCommitResult,
  ActionReadObjectSetSource,
  ActionRunRecord,
  JsonValue,
} from "@sixb/core"
import { commitActionEditBatch, createActionReadFacade, isObjectActionDefinition } from "@sixb/core"
import { recordEdits } from "@sixb/core/actions/worker"
import { emitLocalCommitEvents } from "./commit-events"
import { type BasePhaseContext, requireObjectSubject } from "./context"
import type {
  LoadedObjectTarget,
  PhaseExecutionBase,
  RuntimePhaseHandler,
  UpdateActiveRun,
} from "./types"

export async function runEditsAndCommitPhase(
  input: PhaseExecutionBase & {
    readonly run: ActionRunRecord
    readonly baseContext: BasePhaseContext
    readonly objectTarget: LoadedObjectTarget | null
    readonly writeback: JsonValue | undefined
    readonly updateActiveRun: UpdateActiveRun
  }
): Promise<{ run: ActionRunRecord; result: ActionEditCommitResult | null }> {
  const handler = input.action.phases.edits as RuntimePhaseHandler | undefined
  if (!handler) {
    return { run: input.run, result: null }
  }

  if (input.run.commit) {
    return {
      run: input.run,
      result: {
        diff: input.run.commit.diff,
        committedAt: input.run.commit.committedAt,
        created: false,
      },
    }
  }

  let run = await input.runtime.actionRunsStorage.enterPhase({
    projectId: input.runtime.id,
    id: input.run.id,
    phase: "edits",
  })
  input.updateActiveRun(run)

  const batch = await recordEdits(
    {
      runId: run.id,
      valueTypesById: input.runtime.sixb.getValueTypesById(),
    },
    async ({ objects }) => {
      const baseContext = {
        ...input.baseContext,
        objects,
        read: createActionReadFacade(
          (objectType) => input.runtime.sixb.objects(objectType) as ActionReadObjectSetSource
        ),
        writeback: input.writeback,
      }

      if (isObjectActionDefinition(input.action)) {
        await handler({
          ...baseContext,
          subject: requireObjectSubject(input.run.subject, input.action.id),
        })
        return
      }

      await handler(baseContext)
    }
  )

  run = await input.runtime.actionRunsStorage.enterPhase({
    projectId: input.runtime.id,
    id: input.run.id,
    phase: "commit",
  })
  input.updateActiveRun(run)

  const committed = await commitActionEditBatch({
    storage: input.runtime.storage,
    projectId: input.runtime.id,
    runId: run.id,
    actionId: input.action.id,
    subject: run.subject,
    ontology: input.runtime.sixb,
    batch,
    idempotencyKey: run.idempotencyKey,
  })

  await emitLocalCommitEvents(input.runtime, run.id, committed.commit)

  input.updateActiveRun(committed.run)
  return { run: committed.run, result: committed.commit }
}
