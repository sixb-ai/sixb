import type { ShareGrantStorage } from "../share-grants"
import { ShareSessionStorageError } from "./errors"
import {
  cloneShareSessionRecord,
  normalizeGetShareSessionByIdInput,
  normalizeRenewShareSessionIfValidInput,
  normalizeRevokeShareSessionInput,
  normalizeShareSessionCreate,
  parseShareSessionRecord,
} from "./record"
import type {
  CreateShareSessionInput,
  GetShareSessionByIdInput,
  RenewShareSessionIfValidInput,
  RevokeShareSessionInput,
  ShareSessionRecord,
  ShareSessionStorage,
} from "./types"

export class InMemoryShareSessionStorage implements ShareSessionStorage {
  private rows = new Map<string, ShareSessionRecord>()

  constructor(private readonly grants: Pick<ShareGrantStorage, "getById">) {}

  async create(input: CreateShareSessionInput): Promise<ShareSessionRecord> {
    const record = normalizeShareSessionCreate(input)
    const grant = await this.grants.getById({ projectId: record.projectId, id: record.grantId })
    if (!grant) {
      throw new ShareSessionStorageError(
        "invalid_input",
        `[Sixb] Share grant '${record.grantId}' does not exist in project '${record.projectId}'.`
      )
    }
    const key = rowKey(record.projectId, record.id)
    const duplicateTokenHash = [...this.rows.values()].some(
      (current) => current.projectId === record.projectId && current.tokenHash === record.tokenHash
    )
    if (this.rows.has(key) || duplicateTokenHash) {
      throw new ShareSessionStorageError(
        "duplicate",
        `[Sixb] Share session '${record.id}' conflicts with an existing record.`
      )
    }
    this.rows.set(key, record)
    return cloneShareSessionRecord(record)
  }

  async getById(input: GetShareSessionByIdInput): Promise<ShareSessionRecord | null> {
    const normalized = normalizeGetShareSessionByIdInput(input)
    const record = this.rows.get(rowKey(normalized.projectId, normalized.id))
    return record ? cloneShareSessionRecord(record) : null
  }

  async renewIfValid(input: RenewShareSessionIfValidInput): Promise<ShareSessionRecord | null> {
    const normalized = normalizeRenewShareSessionIfValidInput(input)
    const key = rowKey(normalized.projectId, normalized.id)
    const current = this.rows.get(key)
    if (
      !current ||
      current.grantId !== normalized.grantId ||
      current.tokenHash !== normalized.tokenHash ||
      current.revokedAt !== undefined ||
      current.createdAt.getTime() > normalized.now.getTime() ||
      current.expiresAt.getTime() <= normalized.now.getTime() ||
      current.absoluteExpiresAt.getTime() <= normalized.now.getTime()
    ) {
      return null
    }

    const nextExpiry = Math.min(
      current.absoluteExpiresAt.getTime(),
      Math.max(current.expiresAt.getTime(), normalized.expiresAt.getTime())
    )
    const updated = { ...current, expiresAt: new Date(nextExpiry) }
    this.rows.set(key, updated)
    return cloneShareSessionRecord(updated)
  }

  async revoke(input: RevokeShareSessionInput): Promise<ShareSessionRecord | null> {
    const normalized = normalizeRevokeShareSessionInput(input)
    const key = rowKey(normalized.projectId, normalized.id)
    const current = this.rows.get(key)
    if (!current) return null
    if (current.revokedAt) return cloneShareSessionRecord(current)

    const revocation = normalizeRevokeShareSessionInput(normalized, current.createdAt)
    const updated = { ...current, revokedAt: new Date(revocation.revokedAt) }
    this.rows.set(key, updated)
    return cloneShareSessionRecord(updated)
  }

  snapshot(): ReadonlyMap<string, ShareSessionRecord> {
    return new Map([...this.rows].map(([key, record]) => [key, cloneShareSessionRecord(record)]))
  }

  restore(snapshot: ReadonlyMap<string, ShareSessionRecord>): void {
    this.rows = new Map(
      [...snapshot].map(([key, record]) => [key, parseShareSessionRecord(record)])
    )
  }
}

function rowKey(projectId: string, id: string): string {
  return `${projectId}\0${id}`
}
