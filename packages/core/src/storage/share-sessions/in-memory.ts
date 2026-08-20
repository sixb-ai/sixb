import { ShareSessionStorageError } from "./errors"
import {
  assertSharedAccessSessionRevocation,
  cloneSharedAccessSession,
  normalizeSharedAccessSession,
} from "./record"
import type {
  CreateSharedAccessSessionInput,
  GetSharedAccessSessionInput,
  RevokeSharedAccessSessionInput,
  SharedAccessSessionRecord,
  ShareSessionStorage,
} from "./types"

export class InMemoryShareSessionStorage implements ShareSessionStorage {
  private rows = new Map<string, SharedAccessSessionRecord>()

  async create(input: CreateSharedAccessSessionInput): Promise<SharedAccessSessionRecord> {
    const row = normalizeSharedAccessSession(input)
    const key = rowKey(row.projectId, row.id)
    const duplicateDigest = [...this.rows.values()].some(
      (current) => current.projectId === row.projectId && current.tokenDigest === row.tokenDigest
    )
    if (this.rows.has(key) || duplicateDigest) {
      throw new ShareSessionStorageError(
        `[Sixb] Shared access session '${row.id}' conflicts with an existing record.`,
        "duplicate"
      )
    }

    this.rows.set(key, row)
    return cloneSharedAccessSession(row)
  }

  async get(input: GetSharedAccessSessionInput): Promise<SharedAccessSessionRecord | null> {
    const row = this.rows.get(rowKey(input.projectId, input.sessionId))
    return row ? cloneSharedAccessSession(row) : null
  }

  async revoke(input: RevokeSharedAccessSessionInput): Promise<SharedAccessSessionRecord | null> {
    assertSharedAccessSessionRevocation(input)
    const key = rowKey(input.projectId, input.sessionId)
    const current = this.rows.get(key)
    if (!current) return null
    if (current.revokedAt) return cloneSharedAccessSession(current)
    assertSharedAccessSessionRevocation(input, current.createdAt)

    const updated: SharedAccessSessionRecord = {
      ...current,
      revokedAt: new Date(input.revokedAt),
    }
    this.rows.set(key, updated)
    return cloneSharedAccessSession(updated)
  }

  snapshot(): ReadonlyMap<string, SharedAccessSessionRecord> {
    return new Map([...this.rows].map(([key, row]) => [key, cloneSharedAccessSession(row)]))
  }

  restore(snapshot: ReadonlyMap<string, SharedAccessSessionRecord>): void {
    this.rows = new Map([...snapshot].map(([key, row]) => [key, cloneSharedAccessSession(row)]))
  }
}

function rowKey(projectId: string, sessionId: string): string {
  return `${projectId}\0${sessionId}`
}
