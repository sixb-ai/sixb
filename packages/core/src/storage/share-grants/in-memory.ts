import { ShareGrantStorageError } from "./errors"
import {
  assertSharedAccessGrantRevocation,
  clonePrincipal,
  cloneSharedAccessGrant,
  normalizeSharedAccessGrant,
} from "./record"
import type {
  CreateSharedAccessGrantInput,
  GetSharedAccessGrantInput,
  ListSharedAccessGrantsInput,
  RevokeSharedAccessGrantInput,
  SharedAccessGrantRecord,
  ShareGrantStorage,
} from "./types"

export class InMemoryShareGrantStorage implements ShareGrantStorage {
  private rows = new Map<string, SharedAccessGrantRecord>()

  async create(input: CreateSharedAccessGrantInput): Promise<SharedAccessGrantRecord> {
    const row = normalizeSharedAccessGrant(input)
    const key = rowKey(row.projectId, row.id)
    const duplicateDigest = [...this.rows.values()].some(
      (current) => current.projectId === row.projectId && current.tokenDigest === row.tokenDigest
    )
    if (this.rows.has(key) || duplicateDigest) {
      throw new ShareGrantStorageError(
        `[Sixb] Shared access grant '${row.id}' conflicts with an existing record.`,
        "duplicate"
      )
    }
    this.rows.set(key, row)
    return cloneSharedAccessGrant(row)
  }

  async get(input: GetSharedAccessGrantInput): Promise<SharedAccessGrantRecord | null> {
    const row = this.rows.get(rowKey(input.projectId, input.grantId))
    return row ? cloneSharedAccessGrant(row) : null
  }

  async list(input: ListSharedAccessGrantsInput): Promise<readonly SharedAccessGrantRecord[]> {
    const now = input.now ?? new Date()
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.projectId === input.projectId &&
          (input.shareTypeId === undefined || row.shareTypeId === input.shareTypeId) &&
          (input.target === undefined ||
            (row.target.objectTypeId === input.target.objectTypeId &&
              row.target.primaryId === input.target.primaryId)) &&
          (input.includeRevoked === true || row.revokedAt === undefined) &&
          (input.includeExpired === true || row.expiresAt.getTime() > now.getTime())
      )
      .sort((left, right) => {
        const byCreation = right.createdAt.getTime() - left.createdAt.getTime()
        if (byCreation !== 0) return byCreation
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
      })
      .map(cloneSharedAccessGrant)
  }

  async revoke(input: RevokeSharedAccessGrantInput): Promise<SharedAccessGrantRecord | null> {
    assertSharedAccessGrantRevocation(input)
    const key = rowKey(input.projectId, input.grantId)
    const current = this.rows.get(key)
    if (!current) return null
    if (current.revokedAt) return cloneSharedAccessGrant(current)
    assertSharedAccessGrantRevocation(input, current.createdAt)

    const updated: SharedAccessGrantRecord = {
      ...current,
      revokedAt: new Date(input.revokedAt),
      revokedBy: clonePrincipal(input.revokedBy),
    }
    this.rows.set(key, updated)
    return cloneSharedAccessGrant(updated)
  }

  snapshot(): ReadonlyMap<string, SharedAccessGrantRecord> {
    return new Map([...this.rows].map(([key, row]) => [key, cloneSharedAccessGrant(row)]))
  }

  restore(snapshot: ReadonlyMap<string, SharedAccessGrantRecord>): void {
    this.rows = new Map([...snapshot].map(([key, row]) => [key, cloneSharedAccessGrant(row)]))
  }
}

function rowKey(projectId: string, grantId: string): string {
  return `${projectId}\0${grantId}`
}
