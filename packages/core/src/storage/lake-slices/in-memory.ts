import type {
  DeleteExpiredLakeSlicesInput,
  LakeSliceGrantRecord,
  LakeSliceRecord,
  LakeSliceRef,
  LakeSliceStorage,
  ListLiveLakeSlicesInput,
} from "./types"

export class InMemoryLakeSliceStorage implements LakeSliceStorage {
  private slices = new Map<string, LakeSliceRecord>()
  private grants = new Map<string, LakeSliceGrantRecord>()

  async create(record: LakeSliceRecord): Promise<void> {
    const key = rowKey(record.projectId, record.id)
    if (this.slices.has(key)) throw new Error(`[Sixb] Lake slice '${record.id}' already exists.`)
    this.slices.set(key, structuredClone(record))
  }

  async get(input: LakeSliceRef): Promise<LakeSliceRecord | null> {
    const record = this.slices.get(rowKey(input.projectId, input.id))
    return record ? structuredClone(record) : null
  }

  async delete(input: LakeSliceRef): Promise<void> {
    this.slices.delete(rowKey(input.projectId, input.id))
    for (const [key, grant] of this.grants) {
      if (grant.projectId === input.projectId && grant.sliceId === input.id) this.grants.delete(key)
    }
  }

  async createGrant(record: LakeSliceGrantRecord): Promise<void> {
    const sliceKey = rowKey(record.projectId, record.sliceId)
    const slice = this.slices.get(sliceKey)
    if (!slice) throw new Error(`[Sixb] Lake slice '${record.sliceId}' does not exist.`)
    const duplicate = [...this.grants.values()].some(
      (current) =>
        current.projectId === record.projectId &&
        (current.id === record.id || current.tokenHash === record.tokenHash)
    )
    if (duplicate) throw new Error(`[Sixb] Lake slice grant '${record.id}' conflicts.`)

    this.grants.set(rowKey(record.projectId, record.id), structuredClone(record))
    const last = slice.lastTokenExpiresAt
    if (!last || last.getTime() < record.expiresAt.getTime()) {
      this.slices.set(sliceKey, { ...slice, lastTokenExpiresAt: new Date(record.expiresAt) })
    }
  }

  async markReceived(input: LakeSliceRef & { readonly at: Date }): Promise<void> {
    const key = rowKey(input.projectId, input.id)
    const slice = this.slices.get(key)
    if (slice && !slice.receivedAt)
      this.slices.set(key, { ...slice, receivedAt: new Date(input.at) })
  }

  async findByCredentialHash(input: {
    readonly projectId: string
    readonly credentialHash: string
  }): Promise<LakeSliceRecord | null> {
    for (const slice of this.slices.values()) {
      if (slice.projectId === input.projectId && slice.credentialHash === input.credentialHash) {
        return structuredClone(slice)
      }
    }
    return null
  }

  async findGrantByTokenHash(input: {
    readonly projectId: string
    readonly tokenHash: string
  }): Promise<LakeSliceGrantRecord | null> {
    for (const grant of this.grants.values()) {
      if (grant.projectId === input.projectId && grant.tokenHash === input.tokenHash) {
        return structuredClone(grant)
      }
    }
    return null
  }

  async listLive(input: ListLiveLakeSlicesInput): Promise<readonly LakeSliceRecord[]> {
    return [...this.slices.values()]
      .filter(
        (slice) =>
          slice.projectId === input.projectId && liveUntil(slice) > input.liveAfter.getTime()
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((slice) => structuredClone(slice))
  }

  async deleteExpired(input: DeleteExpiredLakeSlicesInput): Promise<number> {
    const expired = [...this.slices.values()]
      .filter(
        (slice) => slice.projectId === input.projectId && liveUntil(slice) <= input.before.getTime()
      )
      .sort((a, b) => liveUntil(a) - liveUntil(b))
      .slice(0, input.limit)
    for (const slice of expired) await this.delete(slice)

    for (const [key, grant] of this.grants) {
      if (
        grant.projectId === input.projectId &&
        grant.expiresAt.getTime() < input.before.getTime()
      ) {
        this.grants.delete(key)
      }
    }
    return expired.length
  }

  snapshot() {
    return { slices: structuredClone(this.slices), grants: structuredClone(this.grants) }
  }

  restore(snapshot: ReturnType<InMemoryLakeSliceStorage["snapshot"]>): void {
    this.slices = structuredClone(snapshot.slices)
    this.grants = structuredClone(snapshot.grants)
  }
}

function liveUntil(slice: LakeSliceRecord): number {
  return (slice.lastTokenExpiresAt ?? slice.createdAt).getTime()
}

function rowKey(projectId: string, id: string): string {
  return `${projectId}\0${id}`
}
