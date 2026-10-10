import { recordEdits } from "../../edits/recorder"
import type { RecordActionRunInput } from "../../storage"
import type { ActionEditCommitResult } from "../commit-edits"
import { commitActionEdits } from "../commit-edits"
import type { ActionReadRecorder } from "../read-facade"
import { isObjectActionDefinition } from "../validation"
import { type BasePhaseContext, requireObjectSubject, toActionReadFacade } from "./context"
import { throwIfAborted, translateActionPhaseError } from "./normalize"
import type { LoadedObjectTarget, PhaseExecutionBase, RuntimePhaseHandler } from "./phase-types"
import type { ActionRunState } from "./state"

/** The commit of a run's edits, which recorded the run with them. */
export interface CommittedActionRun {
  readonly record: RecordActionRunInput
  readonly commit: ActionEditCommitResult
}

/**
 * Records the run's edits and commits them through the ontology Materializer, together with the
 * run's terminal record. Resolves with `null` for an Action without edits, which commits nothing.
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
    readonly state: ActionRunState
    readonly baseContext: BasePhaseContext
    readonly objectTarget: LoadedObjectTarget | null
    /** Shared with the writeback phase so both phases' reads fence the same commit. */
    readonly reads: ActionReadRecorder
  }
): Promise<CommittedActionRun | null> {
  const handler = input.action.phases.edits as RuntimePhaseHandler | undefined
  if (!handler) return null

  const { state } = input
  const ids = { actionId: input.action.id, runId: state.run.id }
  state.enter("edits")

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
        runId: state.run.id,
        valueTypesById: input.runtime.sixb.objects.getValueTypesById(),
      },
      async ({ objects }) => {
        const baseContext = {
          ...input.baseContext,
          signal: input.signal,
          objects,
          read: toActionReadFacade(input.runtime, reads),
          writeback: state.writebackValue,
        }

        if (isObjectActionDefinition(input.action)) {
          await handler({
            ...baseContext,
            subject: requireObjectSubject(state.run.subject, ids),
          })
          return
        }

        await handler(baseContext)
      }
    )
  } catch (error) {
    throw translateActionPhaseError(error, "edits", { ...ids, signal: input.signal })
  }

  throwIfAborted(input.signal)
  state.enter("commit")
  // Built as the commit starts: the run succeeds exactly when this commit does.
  const record = state.succeeded()

  let commit: ActionEditCommitResult
  try {
    commit = await commitActionEdits({
      mutations: input.runtime.ontologyMutations,
      run: record,
      batch,
      dependencies: reads.dependencies(),
    })
  } catch (error) {
    // The commit ran to its end whatever `signal` did meanwhile, so its error is never a timeout.
    throw translateActionPhaseError(error, "commit", ids)
  }

  return { record, commit }
}
