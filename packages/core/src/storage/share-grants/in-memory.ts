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
  ListShareGrantEvidenceInput,
  RevokeSharedAccessGrantInput,
  SharedAccessGrantRecord,
  ShareGrantEvidenceRecord,
  ShareGrantStorage,
} from "./types"

export class InMemoryShareGrantStorage implements ShareGrantStorage {
  private rows = new Map<string, SharedAccessGrantRecord>()

  async create(input: CreateSharedAccessGrantInput): Promise<SharedAccessGrantRecord> {
    const key = rowKey(input.projectId, input.id)
    if (this.rows.has(key)) {
      throw new ShareGrantStorageError(
        `[Sixb] Shared access grant '${input.id}' already exists.`,
        "duplicate"
      )
    }
    const row = normalizeSharedAccessGrant(input)
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
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
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
      revokedEvidenceId: input.evidenceId,
    }
    this.rows.set(key, updated)
    return cloneSharedAccessGrant(updated)
  }

  async listEvidence(
    input: ListShareGrantEvidenceInput
  ): Promise<readonly ShareGrantEvidenceRecord[]> {
    const evidence: ShareGrantEvidenceRecord[] = []
    const exact =
      input.grantId === undefined
        ? undefined
        : this.rows.get(rowKey(input.projectId, input.grantId))
    const rows = input.grantId === undefined ? this.rows.values() : exact ? [exact] : []
    for (const row of rows) {
      if (row.projectId !== input.projectId) continue
      evidence.push({
        id: row.issuedEvidenceId,
        projectId: row.projectId,
        grantId: row.id,
        type: "share.grant.issued",
        actor: clonePrincipal(row.issuedBy),
        occurredAt: new Date(row.createdAt),
      })
      if (row.revokedAt && row.revokedBy && row.revokedEvidenceId) {
        evidence.push({
          id: row.revokedEvidenceId,
          projectId: row.projectId,
          grantId: row.id,
          type: "share.grant.revoked",
          actor: clonePrincipal(row.revokedBy),
          occurredAt: new Date(row.revokedAt),
        })
      }
    }
    return evidence.sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
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
