import type { ActionRunRecord, EditCommitResult, JsonValue } from "@sixb/core"
import { isObjectActionDefinition, validateEditBatch } from "@sixb/core"
import { recordEdits } from "@sixb/core/internal/edits"
import { ActionWorkerError } from "../errors"
import { emitLocalCommitEvents } from "./commit-events"
import { type BasePhaseContext, createReadFacade, requireObjectSubject } from "./context"
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
): Promise<{ run: ActionRunRecord; result: EditCommitResult | null }> {
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

  const edits = input.runtime.storage.edits
  if (!edits) {
    throw new ActionWorkerError("Action workers require storage.edits support for .edits(...).")
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
        read: createReadFacade(input.runtime.sixb),
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

  await validateEditBatch({
    projectId: input.runtime.id,
    ontology: input.runtime.sixb,
    storage: { objects: input.runtime.storage.objects },
    batch,
  })

  run = await input.runtime.actionRunsStorage.enterPhase({
    projectId: input.runtime.id,
    id: input.run.id,
    phase: "commit",
  })
  input.updateActiveRun(run)

  const result = await edits.commit({
    projectId: input.runtime.id,
    runId: run.id,
    actionId: input.action.id,
    subject: run.subject,
    ontology: input.runtime.sixb,
    batch,
    securityContext: run.securityContext,
    idempotencyKey: run.idempotencyKey,
  })

  await emitLocalCommitEvents(input.runtime, run.id, result)

  const committedRun = await input.runtime.actionRunsStorage.getById({
    projectId: input.runtime.id,
    id: run.id,
  })
  if (committedRun) {
    input.updateActiveRun(committedRun)
    return { run: committedRun, result }
  }

  return { run, result }
}
