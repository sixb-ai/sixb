import type { EditBatch } from "../edits"
import { lowerEditBatch } from "../edits"
import type {
  EditCommitResult,
  EffectiveLinkChange,
  EffectiveObjectChange,
  ExpectedLinkRevision,
  ExpectedLinkScopeRevision,
  ExpectedObjectRevision,
  OntologyOperationOutcome,
} from "../materializer"
import type { OntologyMutationRuntime } from "../runtime/ontology-mutations"
import type { RecordActionRunInput } from "../storage"

/** Exact reads an Action handler depended on, protected by row-level CAS at commit time. */
export interface ActionReadDependencies {
  readonly objects: readonly ExpectedObjectRevision[]
  readonly links: readonly ExpectedLinkRevision[]
  readonly linkScopes: readonly ExpectedLinkScopeRevision[]
}

const NO_READ_DEPENDENCIES: ActionReadDependencies = { objects: [], links: [], linkScopes: [] }

export interface CommitActionEditsInput {
  readonly mutations: Pick<OntologyMutationRuntime, "commitEdits">
  /** The run's terminal record, which the commit inserts with its edits. */
  readonly run: RecordActionRunInput
  readonly batch: EditBatch
  readonly dependencies?: ActionReadDependencies
}

/** The authoritative ontology commit an Action run produced. */
export interface ActionEditCommitResult {
  readonly commitId: string
  readonly created: boolean
  readonly eventCount: number
  readonly outcomes: readonly OntologyOperationOutcome[]
  readonly changes: {
    readonly objects: readonly EffectiveObjectChange[]
    readonly links: readonly EffectiveLinkChange[]
  }
  readonly committedAt: Date
}

/**
 * Commits one Action run's recorded edits as a single atomic ontology commit.
 *
 * The batch lowers to canonical Materializer operations and the Materializer validates the Action run
 * identity, applies managed authority, resolves effective state, writes the authoritative commit,
 * inserts outbox facts, and records the run in one transaction. Repeating the call for the same run
 * replays that commit without recording anything; a divergent request for the same run is a typed
 * idempotency conflict.
 */
export async function commitActionEdits(
  input: CommitActionEditsInput
): Promise<ActionEditCommitResult> {
  const dependencies = input.dependencies ?? NO_READ_DEPENDENCIES
  const commit = await input.mutations.commitEdits({
    mode: "atomic",
    source: { kind: "action", actionId: input.run.actionId, runId: input.run.id },
    run: input.run,
    operations: lowerEditBatch(input.batch),
    expectedObjects: dependencies.objects,
    expectedLinks: dependencies.links,
    expectedLinkScopes: dependencies.linkScopes,
  })
  return toActionEditCommitResult(commit)
}

function toActionEditCommitResult(commit: EditCommitResult): ActionEditCommitResult {
  return {
    commitId: commit.commitId,
    created: commit.created,
    eventCount: commit.eventCount,
    outcomes: commit.outcomes,
    changes: commit.changes,
    committedAt: new Date(commit.committedAt),
  }
}
