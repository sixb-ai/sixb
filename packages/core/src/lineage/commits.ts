import type { AuthorizablePrincipal } from "../execution/types"
import { eventAttribution } from "../materialization/event-envelopes"
import type { EventExecutor } from "../materialization/events"
import type { OntologyObjectRef } from "../materialization/model"
import { objectRefKey } from "../materialization/refs"
import type { ProjectionDefinitionCatalog } from "../projections"
import type { EditOntologyCommitIntent, OntologyCommitRecord } from "../storage/ontology"
import { executorRunKey, viewableExecutorRuns } from "./executors"
import type { LineageReader } from "./reader"
import type { EditLineageSource, TelemetryLineageSource } from "./types"

export type EditCommitRecord = Extract<
  OntologyCommitRecord,
  { readonly intent: EditOntologyCommitIntent }
>

/** What an edit changed on its object: one property, or the object's existence. */
export type EditedChange = { readonly propertyId: string } | "created"

/** Who asked for a commit and what wrote it, as far as the reader may see. */
export interface CommitAttribution {
  readonly requestedBy?: AuthorizablePrincipal
  /** Absent when it names a run the reader cannot view. */
  readonly executor?: EventExecutor
  readonly action?: { readonly actionId: string; readonly runId: string }
}

/** The edit commits made at each of these instants. One read per distinct instant. */
export async function editCommitsAt(
  reader: LineageReader,
  instants: ReadonlySet<string>
): Promise<ReadonlyMap<string, readonly EditCommitRecord[]>> {
  const { projectId, storage } = reader.runtime

  const found = await Promise.all(
    [...instants].map(async (committedAt) => {
      const { commits } = await storage.ontology.commits.list({ projectId, committedAt })
      return [committedAt, commits.filter(isEditCommit)] as const
    })
  )

  return new Map(found)
}

/**
 * The commit, among the edit commits made at one instant, behind one change of an object. An edit
 * time is its commit's `committedAt`, so that commit is among them: the one whose effective change
 * holds this property, or creates the object; or, when none does, the only edit commit there. Null
 * when neither tells one apart.
 */
export function editCommitFor(
  commits: readonly EditCommitRecord[],
  object: OntologyObjectRef,
  change: EditedChange
): EditCommitRecord | null {
  const objectKey = objectRefKey(object)
  const made = commits.filter((commit) =>
    commit.result.changes.objects.some(
      (effective) =>
        objectRefKey(effective.ref) === objectKey &&
        (change === "created"
          ? effective.kind === "created"
          : Object.hasOwn(effective.propertyChanges, change.propertyId))
    )
  )

  const candidates = made.length > 0 ? made : commits
  return candidates.length === 1 ? candidates[0]! : null
}

/** Commits named exactly, by an override or a telemetry point. One read per distinct id. */
export async function commitsById(
  reader: LineageReader,
  commitIds: ReadonlySet<string>
): Promise<ReadonlyMap<string, OntologyCommitRecord>> {
  const { projectId, storage } = reader.runtime

  const found = await Promise.all(
    [...commitIds].map(async (id) => {
      const commit = await storage.ontology.commits.getById({ projectId, id })
      if (!commit) throw new Error(`[Sixb] Ontology commit '${id}', which state names, is missing.`)
      return [id, commit] as const
    })
  )

  return new Map(found)
}

/**
 * Who asked for each commit and what wrote it, read from its execution as its events read them.
 * The requester shows wherever the reader reads the object, as in the object's events. An executor
 * that names a run, and the Action run behind an Action commit, show only when the reader may view
 * that run, as its facade decides; a hidden run is counted as restricted.
 */
export async function attributeCommits(
  reader: LineageReader,
  projections: ProjectionDefinitionCatalog,
  commits: readonly OntologyCommitRecord[]
): Promise<ReadonlyMap<string, CommitAttribution>> {
  const { projectId, storage } = reader.runtime
  const distinct = [...new Map(commits.map((commit) => [commit.id, commit])).values()]

  const executionIds = [...new Set(distinct.map((commit) => commit.executionId))]
  const executions = await Promise.all(
    executionIds.map((id) => storage.executions.getById({ projectId, id }))
  )
  const attributions = new Map(
    executions.flatMap((execution) =>
      execution ? [[execution.id, eventAttribution(execution)] as const] : []
    )
  )

  // An Action commit runs under its run's execution: its executor names that same run.
  const executors = [...attributions.values()].map(({ executor }) => executor)
  const viewable = await viewableExecutorRuns(reader, projections, executors)
  const shows = (executor: EventExecutor) => {
    const key = executorRunKey(executor)
    if (key === undefined || viewable.has(key)) return true

    reader.restrict(key)
    return false
  }

  return new Map(
    distinct.map((commit) => {
      const attribution = attributions.get(commit.executionId)
      if (!attribution) {
        throw new Error(
          `[Sixb] Ontology commit '${commit.id}' has no execution '${commit.executionId}'.`
        )
      }

      const { requestedBy, executor } = attribution
      const requester = requestedBy === undefined ? {} : { requestedBy }
      if (!shows(executor)) return [commit.id, requester] as const

      const origin = commit.origin
      if (origin.kind !== "action") return [commit.id, { ...requester, executor }] as const

      const action = { actionId: origin.actionId, runId: origin.runId }
      return [commit.id, { ...requester, executor, action }] as const
    })
  )
}

export function editSource(
  commit: OntologyCommitRecord,
  attribution: CommitAttribution
): EditLineageSource {
  return { kind: "edit", commitId: commit.id, committedAt: commit.committedAt, ...attribution }
}

export function telemetrySource(
  commit: OntologyCommitRecord,
  attribution: CommitAttribution
): TelemetryLineageSource {
  const projectionId =
    commit.intent.kind === "telemetry" && commit.intent.source.kind === "projection"
      ? commit.intent.source.projection.projectionId
      : undefined

  return {
    kind: "telemetry",
    commitId: commit.id,
    committedAt: commit.committedAt,
    ...(projectionId === undefined ? {} : { projectionId }),
    ...attribution,
  }
}

function isEditCommit(commit: OntologyCommitRecord): commit is EditCommitRecord {
  return commit.intent.kind === "edit"
}
