import { cloneFileDownloadGrantRecord } from "./record"
import type {
  DeleteExpiredFileDownloadGrantsInput,
  FileDownloadGrantRecord,
  FileDownloadGrantStorage,
  FindFileDownloadGrantInput,
  RevokeFileDownloadGrantInput,
} from "./types"

export class InMemoryFileDownloadGrantStorage implements FileDownloadGrantStorage {
  private rows = new Map<string, FileDownloadGrantRecord>()

  async create(record: FileDownloadGrantRecord): Promise<void> {
    const duplicate = [...this.rows.values()].some(
      (current) =>
        current.projectId === record.projectId &&
        (current.id === record.id || current.tokenHash === record.tokenHash)
    )
    if (duplicate) {
      throw new Error(`[Sixb] File download grant '${record.id}' conflicts with an existing one.`)
    }
    this.rows.set(rowKey(record.projectId, record.id), cloneFileDownloadGrantRecord(record))
  }

  async findByTokenHash(
    input: FindFileDownloadGrantInput
  ): Promise<FileDownloadGrantRecord | null> {
    for (const record of this.rows.values()) {
      if (record.projectId === input.projectId && record.tokenHash === input.tokenHash) {
        return cloneFileDownloadGrantRecord(record)
      }
    }
    return null
  }

  async revoke(input: RevokeFileDownloadGrantInput): Promise<FileDownloadGrantRecord | null> {
    const key = rowKey(input.projectId, input.id)
    const current = this.rows.get(key)
    if (!current) return null
    if (!current.revokedAt) {
      this.rows.set(key, { ...current, revokedAt: new Date(input.revokedAt) })
    }
    return cloneFileDownloadGrantRecord(this.rows.get(key) as FileDownloadGrantRecord)
  }

  async deleteExpired(input: DeleteExpiredFileDownloadGrantsInput): Promise<number> {
    const expired = [...this.rows.entries()]
      .filter(
        ([, record]) =>
          record.projectId === input.projectId &&
          record.expiresAt.getTime() < input.expiredBefore.getTime()
      )
      .slice(0, input.limit)
    for (const [key] of expired) this.rows.delete(key)
    return expired.length
  }

  snapshot(): ReadonlyMap<string, FileDownloadGrantRecord> {
    return new Map(
      [...this.rows].map(([key, record]) => [key, cloneFileDownloadGrantRecord(record)])
    )
  }

  restore(snapshot: ReadonlyMap<string, FileDownloadGrantRecord>): void {
    this.rows = new Map(
      [...snapshot].map(([key, record]) => [key, cloneFileDownloadGrantRecord(record)])
    )
  }
}

function rowKey(projectId: string, id: string): string {
  return `${projectId}\0${id}`
}
