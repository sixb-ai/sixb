import type { EditBatch } from "../edits"
import { lowerEditBatch } from "../edits"
import type { EventActor } from "../events/envelope"
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
import type { Storage } from "../storage/types"
import { ActionEditCommitError } from "./errors"

/** Exact reads an Action handler depended on, protected by row-level CAS at commit time. */
export interface ActionReadDependencies {
  readonly objects: readonly ExpectedObjectRevision[]
  readonly links: readonly ExpectedLinkRevision[]
  readonly linkScopes: readonly ExpectedLinkScopeRevision[]
}

const NO_READ_DEPENDENCIES: ActionReadDependencies = { objects: [], links: [], linkScopes: [] }

export interface CommitActionEditsInput {
  readonly mutations: Pick<OntologyMutationRuntime, "commitEdits">
  readonly projectId: string
  readonly runId: string
  readonly actionId: string
  readonly batch: EditBatch
  readonly dependencies?: ActionReadDependencies
  readonly actor?: EventActor
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

export interface FindActionEditCommitInput {
  readonly storage: Pick<Storage, "ontology">
  readonly projectId: string
  readonly runId: string
}

/**
 * Commits one Action run's recorded edits as a single atomic ontology commit.
 *
 * The batch lowers to canonical Materializer operations and the Materializer validates the Action run
 * identity, applies managed authority, resolves effective state, writes the authoritative commit, and
 * inserts outbox facts in one transaction. Repeating the call for the same run replays that commit;
 * a divergent request for the same run is a typed idempotency conflict.
 */
export async function commitActionEdits(
  input: CommitActionEditsInput
): Promise<ActionEditCommitResult> {
  const dependencies = input.dependencies ?? NO_READ_DEPENDENCIES
  const commit = await input.mutations.commitEdits({
    mode: "atomic",
    source: { kind: "action", actionId: input.actionId, runId: input.runId },
    operations: lowerEditBatch(input.batch),
    expectedObjects: dependencies.objects,
    expectedLinks: dependencies.links,
    expectedLinkScopes: dependencies.linkScopes,
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
  })
  return toActionEditCommitResult(commit)
}

/**
 * Resolves the authoritative commit an Action run already produced, if any.
 *
 * Resume uses the exact `{ actionRunId }` origin instead of rerunning handlers, so a redelivered run
 * returns the persisted result without recomputing an idempotency hash.
 */
export async function findActionEditCommit(
  input: FindActionEditCommitInput
): Promise<ActionEditCommitResult | null> {
  const record = await input.storage.ontology.commits.getByOrigin({
    projectId: input.projectId,
    origin: { kind: "action", actionRunId: input.runId },
  })
  if (!record) return null
  if (record.result.kind !== "edit") {
    throw new ActionEditCommitError(
      `[Sixb] Action run '${input.runId}' resolved a '${record.result.kind}' commit instead of an edit commit.`
    )
  }
  return toActionEditCommitResult({ ...record.result, created: false })
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
