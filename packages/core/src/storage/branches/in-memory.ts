import { applyBranchChanges } from "./record"
import type { BranchChanges, BranchRecord, BranchRef, BranchStorage } from "./types"

export class InMemoryBranchStorage implements BranchStorage {
  private rows = new Map<string, BranchRecord>()

  async get(input: BranchRef): Promise<BranchRecord | null> {
    const row = this.rows.get(key(input))
    return row ? structuredClone(row) : null
  }

  async getByNamespace(input: {
    readonly projectId: string
    readonly namespace: string
  }): Promise<BranchRecord | null> {
    const row = [...this.rows.values()].find(
      (candidate) =>
        candidate.projectId === input.projectId && candidate.namespace === input.namespace
    )
    return row ? structuredClone(row) : null
  }

  async list(input: { readonly projectId: string }): Promise<readonly BranchRecord[]> {
    return structuredClone(
      [...this.rows.values()]
        .filter((row) => row.projectId === input.projectId)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    )
  }

  async create(
    record: Omit<BranchRecord, "updatedAt" | "revision">
  ): Promise<{ readonly branch: BranchRecord; readonly created: boolean }> {
    const existing = this.rows.get(key(record))
    if (existing) return { branch: structuredClone(existing), created: false }

    const branch: BranchRecord = { ...record, updatedAt: record.createdAt, revision: 1 }
    this.rows.set(key(record), structuredClone(branch))
    return { branch: structuredClone(branch), created: true }
  }

  async update(
    input: BranchRef & { readonly revision?: number; readonly at: Date },
    changes: BranchChanges
  ): Promise<BranchRecord | null> {
    const existing = this.rows.get(key(input))
    if (!existing) return null
    if (input.revision !== undefined && existing.revision !== input.revision) return null

    const branch = applyBranchChanges(existing, changes, input.at)
    this.rows.set(key(input), structuredClone(branch))
    return structuredClone(branch)
  }

  async delete(input: BranchRef): Promise<boolean> {
    return this.rows.delete(key(input))
  }

  snapshot(): ReadonlyMap<string, BranchRecord> {
    return structuredClone(this.rows)
  }

  restore(snapshot: ReadonlyMap<string, BranchRecord>): void {
    this.rows = structuredClone(new Map(snapshot))
  }
}

function key(input: BranchRef): string {
  return `${input.projectId}\u0000${input.name}`
}
