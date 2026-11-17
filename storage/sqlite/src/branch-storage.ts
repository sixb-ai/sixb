import type { Database } from "bun:sqlite"
import { applyBranchChanges, parseBranchRow, serializeBranch } from "@sixb/core/internal/storage"
import type { BranchChanges, BranchRecord, BranchStorage } from "@sixb/core/storage"
import type { SqliteStoreConnection } from "./transactions"

const SELECT = "SELECT project_id AS projectId, name, revision, record FROM branches"

export class SqliteBranchStorage implements BranchStorage {
  private readonly db: Database

  constructor(connection: SqliteStoreConnection) {
    this.db = connection.db
  }

  async get(input: {
    readonly projectId: string
    readonly name: string
  }): Promise<BranchRecord | null> {
    const row = this.db
      .query(`${SELECT} WHERE project_id = ? AND name = ?`)
      .get(input.projectId, input.name)
    return row ? parseBranchRow(row as Parameters<typeof parseBranchRow>[0]) : null
  }

  async list(input: { readonly projectId: string }): Promise<readonly BranchRecord[]> {
    return this.db
      .query(`${SELECT} WHERE project_id = ? ORDER BY name`)
      .all(input.projectId)
      .map((row) => parseBranchRow(row as Parameters<typeof parseBranchRow>[0]))
  }

  async create(
    record: Omit<BranchRecord, "updatedAt" | "revision">
  ): Promise<{ readonly branch: BranchRecord; readonly created: boolean }> {
    const branch: BranchRecord = { ...record, updatedAt: record.createdAt, revision: 1 }
    const inserted = this.db
      .query(
        `INSERT INTO branches (project_id, name, revision, record) VALUES (?, ?, 1, ?)
         ON CONFLICT (project_id, name) DO NOTHING`
      )
      .run(branch.projectId, branch.name, serializeBranch(branch))
    if (inserted.changes === 1) return { branch, created: true }
    const existing = await this.get(record)
    if (!existing) throw new Error(`[SixbSqlite] Branch '${record.name}' vanished while created.`)
    return { branch: existing, created: false }
  }

  async update(
    input: {
      readonly projectId: string
      readonly name: string
      readonly revision?: number
      readonly at: Date
    },
    changes: BranchChanges
  ): Promise<BranchRecord | null> {
    const existing = await this.get(input)
    if (!existing) return null
    if (input.revision !== undefined && existing.revision !== input.revision) return null
    const branch = applyBranchChanges(existing, changes, input.at)
    const written = this.db
      .query(
        `UPDATE branches SET revision = ?, record = ?
         WHERE project_id = ? AND name = ? AND revision = ?`
      )
      .run(branch.revision, serializeBranch(branch), input.projectId, input.name, existing.revision)
    return written.changes === 1 ? branch : null
  }

  async delete(input: { readonly projectId: string; readonly name: string }): Promise<boolean> {
    const deleted = this.db
      .query("DELETE FROM branches WHERE project_id = ? AND name = ?")
      .run(input.projectId, input.name)
    return deleted.changes === 1
  }
}
