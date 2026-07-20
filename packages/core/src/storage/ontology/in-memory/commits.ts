import type {
  GetOntologyCommitByIdempotencyKeyInput,
  GetOntologyCommitByIdInput,
  GetOntologyCommitByOriginInput,
  ListOntologyCommitsInput,
  ListOntologyCommitsResult,
  OntologyCommitRecord,
  OntologyCommitRunSelector,
  OntologyCommitStorage,
} from "../commits"
import {
  commitKey,
  commitOriginKey,
  type InMemoryOntologyState,
  idempotencyKey,
} from "./shared-state"

export class InMemoryOntologyCommitStorage implements OntologyCommitStorage {
  constructor(
    private readonly state: InMemoryOntologyState,
    private readonly runRootOperation: <T>(run: () => Promise<T> | T) => Promise<T>
  ) {}

  async getByIdempotencyKey(
    input: GetOntologyCommitByIdempotencyKeyInput
  ): Promise<OntologyCommitRecord | null> {
    return this.runRootOperation(() => {
      const id = this.state.commitIdByIdempotency.get(
        idempotencyKey(input.projectId, input.idempotencyKey)
      )
      if (!id) return null
      return structuredClone(this.state.commitsById.get(commitKey(input.projectId, id)) ?? null)
    })
  }

  async getById(input: GetOntologyCommitByIdInput): Promise<OntologyCommitRecord | null> {
    return this.runRootOperation(() =>
      structuredClone(this.state.commitsById.get(commitKey(input.projectId, input.id)) ?? null)
    )
  }

  async getByOrigin(input: GetOntologyCommitByOriginInput): Promise<OntologyCommitRecord | null> {
    return this.runRootOperation(() => {
      assertOriginLookup(input)
      const id = this.state.commitIdByOrigin.get(commitOriginKey(input.projectId, input.origin))
      if (!id) return null
      return structuredClone(this.state.commitsById.get(commitKey(input.projectId, id)) ?? null)
    })
  }

  async list(input: ListOntologyCommitsInput): Promise<ListOntologyCommitsResult> {
    return this.runRootOperation(() => {
      if (input.projectId.trim().length === 0 || input.run?.id.trim().length === 0) {
        throw new Error("[Sixb] Ontology commit project and run ids must be nonblank.")
      }
      const offset = input.offset ?? 0
      const limit = input.limit ?? this.state.commitsById.size
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 0
      ) {
        throw new Error(
          "[Sixb] Ontology commit list limit and offset must be nonnegative integers."
        )
      }
      const direction = input.order === "desc" ? -1 : 1
      const commits = [...this.state.commitsById.values()]
        .filter((commit) => commit.projectId === input.projectId)
        .filter((commit) => (input.run ? commitMatchesRun(commit, input.run) : true))
        .sort((left, right) => {
          if (input.run?.kind === "projection") {
            const byOrdinal = projectionRunOrdinal(left) - projectionRunOrdinal(right)
            if (byOrdinal !== 0) return byOrdinal * direction
          }
          const byTime = left.committedAt.localeCompare(right.committedAt)
          if (byTime !== 0) return byTime * direction
          return left.id.localeCompare(right.id) * direction
        })
      const total = commits.length
      const page = commits.slice(offset, offset + limit).map((commit) => structuredClone(commit))
      return { commits: page, total, hasMore: offset + page.length < total }
    })
  }
}

function assertOriginLookup(input: GetOntologyCommitByOriginInput): void {
  if (input.projectId.trim().length === 0) {
    throw new Error("[Sixb] Ontology commit project id must be nonblank.")
  }
  const runId =
    input.origin.kind === "action" ? input.origin.actionRunId : input.origin.projectionRunId
  if (runId.trim().length === 0) {
    throw new Error("[Sixb] Ontology commit origin run id must be nonblank.")
  }
  if (
    input.origin.kind === "telemetry" &&
    (!Number.isSafeInteger(input.origin.batchOrdinal) || input.origin.batchOrdinal < 0)
  ) {
    throw new Error("[Sixb] Ontology telemetry commit batch ordinal must be nonnegative.")
  }
}

function commitMatchesRun(commit: OntologyCommitRecord, run: OntologyCommitRunSelector): boolean {
  if (run.kind === "action") {
    return commit.origin.kind === "action" && commit.origin.runId === run.id
  }
  if (commit.origin.kind === "projection") return commit.origin.projectionRunId === run.id
  return (
    commit.origin.kind === "telemetry" &&
    commit.origin.source.kind === "projection" &&
    commit.origin.source.projectionRunId === run.id
  )
}

function projectionRunOrdinal(commit: OntologyCommitRecord): number {
  if (commit.origin.kind === "telemetry" && commit.origin.source.kind === "projection") {
    return commit.origin.source.batchOrdinal
  }
  return 0
}
