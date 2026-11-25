import { parseBranchRow, serializeBranch } from "@sixb/core/internal/storage"
import type { BranchChanges, BranchRecord, BranchRef, BranchStorage } from "@sixb/core/storage"
import type { PgStoreClient } from "./transactions"

interface PgBranchRow {
  readonly project_id: string
  readonly name: string
  readonly revision: number
  readonly record: unknown
}

export class PgBranchStorage implements BranchStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async get(input: BranchRef): Promise<BranchRecord | null> {
    const [row] = await this.sql<PgBranchRow[]>`
      SELECT * FROM hosted_branches WHERE project_id = ${input.projectId} AND name = ${input.name}
    `
    return row ? parseBranchRow(row) : null
  }

  async list(input: { readonly projectId: string }): Promise<readonly BranchRecord[]> {
    const rows = await this.sql<PgBranchRow[]>`
      SELECT * FROM hosted_branches WHERE project_id = ${input.projectId} ORDER BY name COLLATE "C"
    `
    return rows.map(parseBranchRow)
  }

  async create(
    record: Omit<BranchRecord, "updatedAt" | "revision">
  ): Promise<{ readonly branch: BranchRecord; readonly created: boolean }> {
    const branch: BranchRecord = { ...record, updatedAt: record.createdAt, revision: 1 }
    const inserted = await this.sql<PgBranchRow[]>`
      INSERT INTO hosted_branches (project_id, name, revision, record)
      VALUES (${branch.projectId}, ${branch.name}, 1, ${serializeBranch(branch)}::text::jsonb)
      ON CONFLICT (project_id, name) DO NOTHING
      RETURNING *
    `
    if (inserted[0]) return { branch: parseBranchRow(inserted[0]), created: true }

    const existing = await this.get(record)
    if (!existing) throw new Error(`[SixbPg] Branch '${record.name}' vanished while it was added.`)
    return { branch: existing, created: false }
  }

  /**
   * One statement compares and writes, so two processes holding the same revision cannot both get
   * through. A change replaces a field whole, as `applyBranchChanges` does.
   */
  async update(
    input: BranchRef & { readonly revision?: number; readonly at: Date },
    changes: BranchChanges
  ): Promise<BranchRecord | null> {
    const revision = input.revision ?? null
    const [row] = await this.sql<PgBranchRow[]>`
      UPDATE hosted_branches
      SET revision = revision + 1,
        record = record || ${JSON.stringify({ ...changes, updatedAt: input.at })}::text::jsonb
      WHERE project_id = ${input.projectId} AND name = ${input.name}
        AND (${revision}::int IS NULL OR revision = ${revision}::int)
      RETURNING *
    `
    return row ? parseBranchRow(row) : null
  }

  async delete(input: BranchRef): Promise<boolean> {
    const rows = await this.sql`
      DELETE FROM hosted_branches WHERE project_id = ${input.projectId} AND name = ${input.name}
      RETURNING name
    `
    return rows.length > 0
  }
}
