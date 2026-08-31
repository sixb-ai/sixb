import type { JsonValue } from "@sixb/core"
import { isObjectActionDefinition } from "@sixb/core"
import { recordEdits } from "@sixb/core/actions/worker"
import type { ActionEditCommitResult, ActionReadRecorder } from "@sixb/core/internal/actions"
import { commitActionEdits } from "@sixb/core/internal/actions"
import type { ActionRunRecord } from "@sixb/core/storage"
import { translateActionPhaseError } from "../normalize"
import { type BasePhaseContext, requireObjectSubject, toActionReadFacade } from "./context"
import type {
  LoadedObjectTarget,
  PhaseExecutionBase,
  RuntimePhaseHandler,
  UpdateActiveRun,
} from "./types"

/**
 * Records the run's edits and commits them through the ontology Materializer.
 *
 * Exact object and link-scope reads performed by the writeback and edits handlers are captured as
 * expected revisions so a commit fails when that state changes. Query/list results and telemetry
 * history stay call-level snapshots. Domain events are durable outbox facts written inside the
 * commit, so this phase never appends events itself.
 */
export async function runEditsAndCommitPhase(
  input: PhaseExecutionBase & {
    readonly run: ActionRunRecord
    readonly baseContext: BasePhaseContext
    readonly objectTarget: LoadedObjectTarget | null
    readonly writeback: JsonValue | undefined
    readonly existingCommit: ActionEditCommitResult | null
    /** Shared with the writeback phase so both phases' reads fence the same commit. */
    readonly reads: ActionReadRecorder
    readonly updateActiveRun: UpdateActiveRun
  }
): Promise<{ run: ActionRunRecord; result: ActionEditCommitResult | null }> {
  const handler = input.action.phases.edits as RuntimePhaseHandler | undefined
  if (!handler) {
    return { run: input.run, result: null }
  }

  if (input.existingCommit) {
    return { run: input.run, result: input.existingCommit }
  }

  let run = await input.runtime.actionRunsStorage.enterPhase({
    projectId: input.runtime.id,
    id: input.run.id,
    phase: "edits",
  })
  input.updateActiveRun(run)

  const reads = input.reads
  if (input.objectTarget) {
    reads.observeObject(
      {
        objectTypeId: input.objectTarget.row.objectTypeId,
        primaryId: input.objectTarget.row.primaryId,
      },
      input.objectTarget.row
    )
  }

  let batch: Awaited<ReturnType<typeof recordEdits>>
  try {
    batch = await recordEdits(
      {
        runId: run.id,
        valueTypesById: input.runtime.sixb.objects.getValueTypesById(),
      },
      async ({ objects }) => {
        const baseContext = {
          ...input.baseContext,
          objects,
          read: toActionReadFacade(input.runtime, reads),
          writeback: input.writeback,
        }

        if (isObjectActionDefinition(input.action)) {
          await handler({
            ...baseContext,
            subject: requireObjectSubject(input.run.subject, {
              actionId: input.action.id,
              runId: input.run.id,
            }),
          })
          return
        }

        await handler(baseContext)
      }
    )
  } catch (error) {
    throw translateActionPhaseError(error, "edits", {
      actionId: input.action.id,
      runId: input.run.id,
      signal: input.signal,
    })
  }

  run = await input.runtime.actionRunsStorage.enterPhase({
    projectId: input.runtime.id,
    id: input.run.id,
    phase: "commit",
  })
  input.updateActiveRun(run)

  let commit: ActionEditCommitResult
  try {
    commit = await commitActionEdits({
      mutations: input.runtime.ontologyMutations,
      projectId: input.runtime.id,
      runId: run.id,
      actionId: input.action.id,
      batch,
      dependencies: reads.dependencies(),
    })
  } catch (error) {
    throw translateActionPhaseError(error, "commit", {
      actionId: input.action.id,
      runId: input.run.id,
      signal: input.signal,
    })
  }

  return { run, result: commit }
}
