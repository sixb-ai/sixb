import { recordEdits } from "../../edits/recorder"
import type { JsonValue } from "../../json"
import type { ActionRunRecord } from "../../storage"
import type { ActionEditCommitResult } from "../commit-edits"
import { commitActionEdits } from "../commit-edits"
import type { ActionReadRecorder } from "../read-facade"
import { isObjectActionDefinition } from "../validation"
import { type BasePhaseContext, requireObjectSubject, toActionReadFacade } from "./context"
import { throwIfAborted, translateActionPhaseError } from "./normalize"
import type {
  LoadedObjectTarget,
  PhaseExecutionBase,
  RuntimePhaseHandler,
  UpdateActiveRun,
} from "./phase-types"

/**
 * Records the run's edits and commits them through the ontology Materializer.
 *
 * Object and link-scope reads performed by the writeback and edits handlers, including every object
 * a query or listing returned, are captured as expected revisions so a commit fails when that state
 * changes. Query membership and telemetry history stay call-level snapshots. Domain events are
 * durable outbox facts written inside the commit, so this phase never appends events itself.
 *
 * `signal` stops the edits handler and the step before the commit; the commit itself is never
 * interrupted.
 */
export async function runEditsAndCommitPhase(
  input: PhaseExecutionBase & {
    readonly run: ActionRunRecord
    readonly baseContext: BasePhaseContext
    readonly objectTarget: LoadedObjectTarget | null
    readonly writeback: JsonValue | undefined
    /** Shared with the writeback phase so both phases' reads fence the same commit. */
    readonly reads: ActionReadRecorder
    readonly updateActiveRun: UpdateActiveRun
  }
): Promise<{ run: ActionRunRecord; result: ActionEditCommitResult | null }> {
  const handler = input.action.phases.edits as RuntimePhaseHandler | undefined
  if (!handler) {
    return { run: input.run, result: null }
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
          signal: input.signal,
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

  throwIfAborted(input.signal)
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
    // The commit ran to its end whatever `signal` did meanwhile, so its error is never a timeout.
    throw translateActionPhaseError(error, "commit", {
      actionId: input.action.id,
      runId: input.run.id,
    })
  }

  return { run, result: commit }
}
