import { type Principal, principalsEqual } from "../../auth"
import { paginate } from "../pagination"
import { artifactStateBytes, artifactStorageErrors, checkArtifactStateWrite } from "./record"
import type {
  ArtifactFrameGrantRecord,
  ArtifactRecord,
  ArtifactStateEntry,
  ArtifactStateKeyInput,
  ArtifactStateScope,
  ArtifactStorage,
  ArtifactVersionInput,
  ArtifactVersionRecord,
  CreateArtifactInput,
  DeleteArtifactInput,
  DeleteArtifactVersionsByOriginInput,
  DeleteExpiredArtifactFrameGrantsInput,
  FindArtifactFrameGrantInput,
  GetArtifactInput,
  GetArtifactVersionInput,
  ListArtifactsInput,
  ListArtifactsResult,
  ListArtifactVersionsInput,
  ListArtifactVersionsResult,
  ListReferencingVersionsInput,
  PublishArtifactVersionInput,
  PublishedArtifactVersion,
  SetArtifactStateInput,
} from "./types"

interface StoredArtifact {
  readonly record: ArtifactRecord
  /** Oldest first. */
  readonly versions: readonly ArtifactVersionRecord[]
  /** The number the next version gets; it only grows, so a deleted number is never reused. */
  readonly nextVersion: number
}

interface InMemoryArtifactSnapshot {
  readonly artifacts: ReadonlyMap<string, StoredArtifact>
  readonly frameGrants: ReadonlyMap<string, ArtifactFrameGrantRecord>
  readonly state: ReadonlyMap<string, ReadonlyMap<string, ArtifactStateEntry>>
}

export class InMemoryArtifactStorage implements ArtifactStorage {
  private artifacts = new Map<string, StoredArtifact>()
  private frameGrants = new Map<string, ArtifactFrameGrantRecord>()
  /** By artifact and reader, then by key. */
  private state = new Map<string, Map<string, ArtifactStateEntry>>()

  async create(input: CreateArtifactInput): Promise<PublishedArtifactVersion> {
    const key = artifactKey(input.projectId, input.id)
    if (this.artifacts.has(key)) throw artifactStorageErrors.exists(input.id)
    const version = versionRecord(input.projectId, input.id, 1, input.version)
    const record: ArtifactRecord = {
      projectId: input.projectId,
      id: input.id,
      kind: input.kind,
      title: version.title,
      owner: { ...input.owner },
      latestVersion: 1,
      createdAt: new Date(version.createdAt),
      updatedAt: new Date(version.createdAt),
    }
    this.artifacts.set(key, { record, versions: [version], nextVersion: 2 })
    return published(record, version)
  }

  async publish(input: PublishArtifactVersionInput): Promise<PublishedArtifactVersion> {
    const key = artifactKey(input.projectId, input.artifactId)
    const stored = this.artifacts.get(key)
    if (!stored) throw artifactStorageErrors.notFound(input.artifactId)
    if (stored.record.kind !== input.kind) {
      throw artifactStorageErrors.kindMismatch(input.artifactId, stored.record.kind, input.kind)
    }
    const latest = stored.versions.find(
      (candidate) => candidate.version === stored.record.latestVersion
    )
    if (input.baseVersion !== undefined && latest && latest.version !== input.baseVersion) {
      throw artifactStorageErrors.moved(input.artifactId, input.baseVersion, {
        version: latest.version,
        author: structuredClone(latest.author),
      })
    }
    const version = versionRecord(
      input.projectId,
      input.artifactId,
      stored.nextVersion,
      input.version
    )
    const record: ArtifactRecord = {
      ...stored.record,
      title: version.title,
      latestVersion: version.version,
      updatedAt: new Date(version.createdAt),
    }
    this.artifacts.set(key, {
      record,
      versions: [...stored.versions, version],
      nextVersion: stored.nextVersion + 1,
    })
    return published(record, version)
  }

  async get(input: GetArtifactInput): Promise<ArtifactRecord | null> {
    const stored = this.artifacts.get(artifactKey(input.projectId, input.id))
    return stored ? structuredClone(stored.record) : null
  }

  async list(input: ListArtifactsInput): Promise<ListArtifactsResult> {
    const matching = [...this.artifacts.values()]
      .filter(
        ({ record, versions }) =>
          record.projectId === input.projectId &&
          (!input.owner || principalsEqual(record.owner, input.owner)) &&
          (input.kind === undefined || record.kind === input.kind) &&
          (input.originThreadId === undefined ||
            versions.some((version) => version.origin?.threadId === input.originThreadId))
      )
      .map(({ record }) => record)
      .sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id)
      )
    const { page, hasMore, total } = paginate(matching, input)
    return { artifacts: structuredClone(page), hasMore, total }
  }

  async getVersion(input: GetArtifactVersionInput): Promise<ArtifactVersionRecord | null> {
    const stored = this.artifacts.get(artifactKey(input.projectId, input.artifactId))
    const version = stored?.versions.find((candidate) => candidate.version === input.version)
    return version ? structuredClone(version) : null
  }

  async listVersions(input: ListArtifactVersionsInput): Promise<ListArtifactVersionsResult> {
    const stored = this.artifacts.get(artifactKey(input.projectId, input.artifactId))
    const newestFirst = [...(stored?.versions ?? [])].reverse()
    const { page, hasMore, total } = paginate(newestFirst, input)
    return { versions: structuredClone(page), hasMore, total }
  }

  async listReferencingVersions(
    input: ListReferencingVersionsInput
  ): Promise<ArtifactVersionRecord[]> {
    const prefix = `artifact:${input.artifactId}`
    const referencing: ArtifactVersionRecord[] = []
    for (const stored of this.artifacts.values()) {
      if (stored.record.projectId !== input.projectId) continue
      const latest = stored.versions.find(
        (candidate) => candidate.version === stored.record.latestVersion
      )
      if (latest?.references.some((reference) => refersTo(reference.address, prefix))) {
        referencing.push(structuredClone(latest))
      }
    }
    // Code-unit order, as SQLite compares text.
    return referencing.sort((left, right) => (left.artifactId < right.artifactId ? -1 : 1))
  }

  async createFrameGrant(record: ArtifactFrameGrantRecord): Promise<void> {
    if (!this.artifacts.has(artifactKey(record.projectId, record.artifactId))) {
      throw artifactStorageErrors.notFound(record.artifactId)
    }
    this.frameGrants.set(artifactKey(record.projectId, record.tokenHash), structuredClone(record))
  }

  async findFrameGrant(
    input: FindArtifactFrameGrantInput
  ): Promise<ArtifactFrameGrantRecord | null> {
    const grant = this.frameGrants.get(artifactKey(input.projectId, input.tokenHash))
    return grant ? structuredClone(grant) : null
  }

  async deleteExpiredFrameGrants(input: DeleteExpiredArtifactFrameGrantsInput): Promise<number> {
    let deleted = 0
    for (const [key, grant] of this.frameGrants) {
      if (deleted >= input.limit) break
      if (grant.projectId !== input.projectId || grant.expiresAt >= input.expiredBefore) continue
      this.frameGrants.delete(key)
      deleted += 1
    }
    return deleted
  }

  async getState(input: ArtifactStateKeyInput): Promise<ArtifactStateEntry | null> {
    const entry = this.state.get(stateKey(input))?.get(input.key)
    return entry ? structuredClone(entry) : null
  }

  async setState(input: SetArtifactStateInput): Promise<void> {
    if (!this.artifacts.has(artifactKey(input.projectId, input.artifactId))) {
      throw artifactStorageErrors.notFound(input.artifactId)
    }
    const kept = this.state.get(stateKey(input)) ?? new Map<string, ArtifactStateEntry>()
    const others = [...kept.values()].filter((entry) => entry.key !== input.key)
    const sizeBytes = artifactStateBytes(input.value)
    checkArtifactStateWrite({
      key: input.key,
      valueBytes: sizeBytes,
      others: {
        keys: others.length,
        bytes: others.reduce((total, entry) => total + entry.sizeBytes, 0),
      },
    })
    kept.set(input.key, {
      key: input.key,
      value: input.value,
      sizeBytes,
      updatedAt: new Date(input.updatedAt),
    })
    this.state.set(stateKey(input), kept)
  }

  async deleteState(input: ArtifactStateKeyInput): Promise<boolean> {
    return this.state.get(stateKey(input))?.delete(input.key) ?? false
  }

  async listState(input: ArtifactStateScope): Promise<ArtifactStateEntry[]> {
    const kept = [...(this.state.get(stateKey(input))?.values() ?? [])]
    // Code-unit order, as SQLite compares text.
    return structuredClone(kept.sort((left, right) => (left.key < right.key ? -1 : 1)))
  }

  async clearState(input: ArtifactStateScope): Promise<number> {
    const count = this.state.get(stateKey(input))?.size ?? 0
    this.state.delete(stateKey(input))
    return count
  }

  async delete(input: DeleteArtifactInput): Promise<boolean> {
    return this.deleteArtifact(artifactKey(input.projectId, input.id))
  }

  async deleteVersionsByOrigin(input: DeleteArtifactVersionsByOriginInput): Promise<number> {
    let deleted = 0
    for (const [key, stored] of this.artifacts) {
      if (stored.record.projectId !== input.projectId) continue
      const remaining = stored.versions.filter((version) => version.origin?.runId !== input.runId)
      if (remaining.length === stored.versions.length) continue
      deleted += stored.versions.length - remaining.length
      const latest = remaining.at(-1)
      if (!latest) {
        this.deleteArtifact(key)
        continue
      }
      this.artifacts.set(key, {
        ...stored,
        record: {
          ...stored.record,
          title: latest.title,
          latestVersion: latest.version,
          updatedAt: new Date(latest.createdAt),
        },
        versions: remaining,
      })
    }
    return deleted
  }

  snapshot(): InMemoryArtifactSnapshot {
    return structuredClone({
      artifacts: this.artifacts,
      frameGrants: this.frameGrants,
      state: this.state,
    })
  }

  restore(snapshot: InMemoryArtifactSnapshot): void {
    const restored = structuredClone(snapshot)
    this.artifacts = new Map(restored.artifacts)
    this.frameGrants = new Map(restored.frameGrants)
    this.state = new Map([...restored.state].map(([key, kept]) => [key, new Map(kept)]))
  }

  /**
   * Deletes an artifact with its frame grants and what it keeps for its readers, as the SQL
   * providers' cascade does.
   */
  private deleteArtifact(key: string): boolean {
    for (const [grantKey, grant] of this.frameGrants) {
      if (artifactKey(grant.projectId, grant.artifactId) === key) this.frameGrants.delete(grantKey)
    }
    for (const kept of this.state.keys()) {
      if (kept.startsWith(`${key}\0`)) this.state.delete(kept)
    }
    return this.artifacts.delete(key)
  }
}

function versionRecord(
  projectId: string,
  artifactId: string,
  version: number,
  input: ArtifactVersionInput
): ArtifactVersionRecord {
  return structuredClone({ ...input, projectId, artifactId, version })
}

function published(
  record: ArtifactRecord,
  version: ArtifactVersionRecord
): PublishedArtifactVersion {
  return structuredClone({ artifact: record, version })
}

function artifactKey(projectId: string, id: string): string {
  return `${projectId}\0${id}`
}

/** An artifact's key, then its reader's. */
function stateKey(scope: {
  readonly projectId: string
  readonly artifactId: string
  readonly principal: Principal
}): string {
  return `${artifactKey(scope.projectId, scope.artifactId)}\0${scope.principal.type}\0${scope.principal.id}`
}

/** Whether an address names the artifact `artifact:<id>` is, at any version, file, or part. */
function refersTo(address: string, prefix: string): boolean {
  return address.startsWith(prefix) && /^(?:$|[@/#])/.test(address.slice(prefix.length))
}
