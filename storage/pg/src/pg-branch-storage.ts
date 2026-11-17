import { applyBranchChanges, parseBranchRow, serializeBranch } from "@sixb/core/internal/storage"
import type { BranchChanges, BranchRecord, BranchStorage } from "@sixb/core/storage"
import type { PgStoreClient } from "./transactions"

interface PgBranchRow {
  readonly project_id: string
  readonly name: string
  readonly revision: number
  readonly record: unknown
}

export class PgBranchStorage implements BranchStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async get(input: {
    readonly projectId: string
    readonly name: string
  }): Promise<BranchRecord | null> {
    const [row] = await this.sql<PgBranchRow[]>`
      SELECT project_id, name, revision, record FROM branches
      WHERE project_id = ${input.projectId} AND name = ${input.name}
    `
    return row ? parse(row) : null
  }

  async list(input: { readonly projectId: string }): Promise<readonly BranchRecord[]> {
    const rows = await this.sql<PgBranchRow[]>`
      SELECT project_id, name, revision, record FROM branches
      WHERE project_id = ${input.projectId}
      ORDER BY name COLLATE "C"
    `
    return rows.map(parse)
  }

  async create(
    record: Omit<BranchRecord, "updatedAt" | "revision">
  ): Promise<{ readonly branch: BranchRecord; readonly created: boolean }> {
    const branch: BranchRecord = { ...record, updatedAt: record.createdAt, revision: 1 }
    const inserted = await this.sql`
      INSERT INTO branches (project_id, name, revision, record)
      VALUES (${branch.projectId}, ${branch.name}, 1, ${serializeBranch(branch)}::text::jsonb)
      ON CONFLICT (project_id, name) DO NOTHING
    `
    if (inserted.count === 1) return { branch, created: true }
    const existing = await this.get(record)
    if (!existing) throw new Error(`[SixbPostgres] Branch '${record.name}' vanished while created.`)
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
    const written = await this.sql`
      UPDATE branches SET revision = ${branch.revision}, record = ${serializeBranch(branch)}::text::jsonb
      WHERE project_id = ${input.projectId} AND name = ${input.name}
        AND revision = ${existing.revision}
    `
    return written.count === 1 ? branch : null
  }

  async delete(input: { readonly projectId: string; readonly name: string }): Promise<boolean> {
    const deleted = await this.sql`
      DELETE FROM branches WHERE project_id = ${input.projectId} AND name = ${input.name}
    `
    return deleted.count === 1
  }
}

function parse(row: PgBranchRow): BranchRecord {
  return parseBranchRow({
    projectId: row.project_id,
    name: row.name,
    revision: row.revision,
    record: row.record,
  })
}
