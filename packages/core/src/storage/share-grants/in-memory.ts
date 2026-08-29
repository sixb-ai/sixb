import { ShareGrantStorageError } from "./errors"
import {
  cloneShareGrantRecord,
  normalizeGetShareGrantByIdInput,
  normalizeListShareGrantsInput,
  normalizeRevokeShareGrantInput,
  normalizeShareGrantCreate,
  parseShareGrantRecord,
} from "./record"
import type {
  CreateShareGrantInput,
  GetShareGrantByIdInput,
  ListShareGrantsInput,
  ListShareGrantsResult,
  RevokeShareGrantInput,
  ShareGrantRecord,
  ShareGrantStorage,
} from "./types"

export class InMemoryShareGrantStorage implements ShareGrantStorage {
  private rows = new Map<string, ShareGrantRecord>()

  async create(input: CreateShareGrantInput): Promise<ShareGrantRecord> {
    const record = normalizeShareGrantCreate(input)
    const key = rowKey(record.projectId, record.id)
    const duplicateTokenHash = [...this.rows.values()].some(
      (current) => current.projectId === record.projectId && current.tokenHash === record.tokenHash
    )
    if (this.rows.has(key) || duplicateTokenHash) {
      throw new ShareGrantStorageError(
        "duplicate",
        `[Sixb] Share grant '${record.id}' conflicts with an existing record.`
      )
    }

    this.rows.set(key, record)
    return cloneShareGrantRecord(record)
  }

  async getById(input: GetShareGrantByIdInput): Promise<ShareGrantRecord | null> {
    const normalized = normalizeGetShareGrantByIdInput(input)
    const record = this.rows.get(rowKey(normalized.projectId, normalized.id))
    return record ? cloneShareGrantRecord(record) : null
  }

  async list(input: ListShareGrantsInput): Promise<ListShareGrantsResult> {
    const normalized = normalizeListShareGrantsInput(input)
    const matching = [...this.rows.values()]
      .filter(
        (record) =>
          record.projectId === normalized.projectId &&
          (normalized.definitionId === undefined ||
            record.definitionId === normalized.definitionId) &&
          (normalized.target === undefined ||
            (record.target.objectTypeId === normalized.target.objectTypeId &&
              record.target.primaryId === normalized.target.primaryId)) &&
          (normalized.includeRevoked || record.revokedAt === undefined) &&
          (normalized.includeExpired || record.expiresAt.getTime() > normalized.now.getTime())
      )
      .sort(compareShareGrants)

    const total = matching.length
    const grants = matching
      .slice(normalized.offset, normalized.offset + normalized.limit)
      .map(cloneShareGrantRecord)
    return {
      grants,
      total,
      hasMore: normalized.offset + grants.length < total,
    }
  }

  async revoke(input: RevokeShareGrantInput): Promise<ShareGrantRecord | null> {
    const normalized = normalizeRevokeShareGrantInput(input)
    const key = rowKey(normalized.projectId, normalized.id)
    const current = this.rows.get(key)
    if (!current) return null
    if (current.revokedAt) return cloneShareGrantRecord(current)

    const revocation = normalizeRevokeShareGrantInput(normalized, current.createdAt)
    const updated: ShareGrantRecord = {
      ...current,
      revokedAt: new Date(revocation.revokedAt),
      revokedBy: { ...revocation.revokedBy },
    }
    this.rows.set(key, updated)
    return cloneShareGrantRecord(updated)
  }

  snapshot(): ReadonlyMap<string, ShareGrantRecord> {
    return new Map([...this.rows].map(([key, record]) => [key, cloneShareGrantRecord(record)]))
  }

  restore(snapshot: ReadonlyMap<string, ShareGrantRecord>): void {
    this.rows = new Map([...snapshot].map(([key, record]) => [key, parseShareGrantRecord(record)]))
  }
}

function compareShareGrants(left: ShareGrantRecord, right: ShareGrantRecord): number {
  const created = right.createdAt.getTime() - left.createdAt.getTime()
  if (created !== 0) return created
  return left.id === right.id ? 0 : left.id < right.id ? 1 : -1
}

function rowKey(projectId: string, id: string): string {
  return `${projectId}\0${id}`
}
