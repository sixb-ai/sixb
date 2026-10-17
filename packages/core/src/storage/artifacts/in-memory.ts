import { principalsEqual } from "../../auth"
import { paginate } from "../pagination"
import { artifactStorageErrors, cloneArtifactRecord, cloneArtifactVersionRecord } from "./record"
import type {
  ArtifactFrameGrantRecord,
  ArtifactRecord,
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
} from "./types"

interface StoredArtifact {
  readonly record: ArtifactRecord
  /** Oldest first. */
  readonly versions: readonly ArtifactVersionRecord[]
  /** The number the next version gets; it only grows, so a deleted number is never reused. */
  readonly nextVersion: number
}

export class InMemoryArtifactStorage implements ArtifactStorage {
  private artifacts = new Map<string, StoredArtifact>()
  private frameGrants = new Map<string, ArtifactFrameGrantRecord>()

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
    return stored ? cloneArtifactRecord(stored.record) : null
  }

  async list(input: ListArtifactsInput): Promise<ListArtifactsResult> {
    const matching = [...this.artifacts.values()]
      .filter(
        ({ record, versions }) =>
          record.projectId === input.projectId &&
          (!input.owner || principalsEqual(record.owner, input.owner)) &&
          (input.originThreadId === undefined ||
            versions.some((version) => version.origin?.threadId === input.originThreadId))
      )
      .map(({ record }) => record)
      .sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id)
      )
    const { page, hasMore, total } = paginate(matching, input)
    return { artifacts: page.map(cloneArtifactRecord), hasMore, total }
  }

  async getVersion(input: GetArtifactVersionInput): Promise<ArtifactVersionRecord | null> {
    const stored = this.artifacts.get(artifactKey(input.projectId, input.artifactId))
    const version = stored?.versions.find((candidate) => candidate.version === input.version)
    return version ? cloneArtifactVersionRecord(version) : null
  }

  async listVersions(input: ListArtifactVersionsInput): Promise<ListArtifactVersionsResult> {
    const stored = this.artifacts.get(artifactKey(input.projectId, input.artifactId))
    const newestFirst = [...(stored?.versions ?? [])].reverse()
    const { page, hasMore, total } = paginate(newestFirst, input)
    return { versions: page.map(cloneArtifactVersionRecord), hasMore, total }
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
        referencing.push(cloneArtifactVersionRecord(latest))
      }
    }
    return referencing
  }

  async createFrameGrant(record: ArtifactFrameGrantRecord): Promise<void> {
    if (!this.artifacts.has(artifactKey(record.projectId, record.artifactId))) {
      throw artifactStorageErrors.notFound(record.artifactId)
    }
    this.frameGrants.set(artifactKey(record.projectId, record.tokenHash), { ...record })
  }

  async findFrameGrant(
    input: FindArtifactFrameGrantInput
  ): Promise<ArtifactFrameGrantRecord | null> {
    const grant = this.frameGrants.get(artifactKey(input.projectId, input.tokenHash))
    return grant ? { ...grant } : null
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

  async delete(input: DeleteArtifactInput): Promise<boolean> {
    const key = artifactKey(input.projectId, input.id)
    for (const [grantKey, grant] of this.frameGrants) {
      if (artifactKey(grant.projectId, grant.artifactId) === key) this.frameGrants.delete(grantKey)
    }
    return this.artifacts.delete(key)
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
        this.artifacts.delete(key)
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

  snapshot(): ReadonlyMap<string, StoredArtifact> {
    return cloneArtifacts(this.artifacts)
  }

  restore(snapshot: ReadonlyMap<string, StoredArtifact>): void {
    this.artifacts = cloneArtifacts(snapshot)
  }
}

function versionRecord(
  projectId: string,
  artifactId: string,
  version: number,
  input: ArtifactVersionInput
): ArtifactVersionRecord {
  return cloneArtifactVersionRecord({ ...input, projectId, artifactId, version })
}

function published(
  record: ArtifactRecord,
  version: ArtifactVersionRecord
): PublishedArtifactVersion {
  return { artifact: cloneArtifactRecord(record), version: cloneArtifactVersionRecord(version) }
}

function cloneArtifacts(
  artifacts: ReadonlyMap<string, StoredArtifact>
): Map<string, StoredArtifact> {
  return new Map([...artifacts].map(([key, stored]) => [key, structuredClone(stored)]))
}

function artifactKey(projectId: string, id: string): string {
  return `${projectId}\0${id}`
}

/** Whether an address names the artifact `artifact:<id>` is, at any version, file, or part. */
function refersTo(address: string, prefix: string): boolean {
  return address.startsWith(prefix) && /^(?:$|[@/#])/.test(address.slice(prefix.length))
}
