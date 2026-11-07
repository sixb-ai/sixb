import type { LakeRetentionRunRecord, LakeRetentionRunStorage } from "./types"

export class InMemoryLakeRetentionRunStorage implements LakeRetentionRunStorage {
  private rows = new Map<string, LakeRetentionRunRecord>()

  async record(run: LakeRetentionRunRecord): Promise<void> {
    this.rows.set(run.projectId, structuredClone(run))
  }

  async getLast(input: { readonly projectId: string }): Promise<LakeRetentionRunRecord | null> {
    const row = this.rows.get(input.projectId)
    return row ? structuredClone(row) : null
  }

  snapshot(): ReadonlyMap<string, LakeRetentionRunRecord> {
    return structuredClone(this.rows)
  }

  restore(snapshot: ReadonlyMap<string, LakeRetentionRunRecord>): void {
    this.rows = structuredClone(new Map(snapshot))
  }
}
