import type { Principal } from "@sixb/core"
import {
  agentMemoryConflicts,
  agentMemoryHistoryCutoff,
  assertSaveAgentMemoryInput,
} from "@sixb/core/internal/agent-run-storage-provider"
import type {
  AgentMemoryRepoRecord,
  AgentMemoryRevisionRecord,
  AgentMemoryStore,
  ListAgentMemoryRevisionsInput,
  ListAgentMemoryRevisionsResult,
  SaveAgentMemoryInput,
  SaveAgentMemoryResult,
} from "@sixb/core/storage"
import { lockAdvisoryKeys, type PgStoreClient, runPgTransaction } from "../transactions"

interface RevisionRow {
  readonly revision: number
  readonly message: string
  readonly author_principal_type: Principal["type"]
  readonly author_principal_id: string
  readonly source: string | null
  readonly created_at: Date
}

export class PgAgentMemoryStore implements AgentMemoryStore {
  constructor(private readonly sql: PgStoreClient) {}

  async get(input: {
    projectId: string
    repoId: string
    asOf?: Date
  }): Promise<AgentMemoryRepoRecord> {
    const asOf = input.asOf ?? null
    // One statement, so the head and the files come from one snapshot.
    const rows = await this.sql<{ head: number; path: string | null; contents: string | null }[]>`
      WITH head AS (
        SELECT COALESCE(MAX(revision), 0)::int AS revision FROM agent_memory_revisions
        WHERE project_id = ${input.projectId} AND repo_id = ${input.repoId}
          AND (${asOf}::timestamptz IS NULL OR created_at <= ${asOf}::timestamptz)
      ), latest AS (
        SELECT DISTINCT ON (f.path) f.path, f.contents FROM agent_memory_files f, head
        WHERE f.project_id = ${input.projectId} AND f.repo_id = ${input.repoId}
          AND f.revision <= head.revision
        ORDER BY f.path, f.revision DESC
      )
      SELECT head.revision AS head, latest.path, latest.contents
      FROM head
      LEFT JOIN latest ON latest.contents IS NOT NULL
      ORDER BY latest.path
    `
    return {
      revision: rows[0]?.head ?? 0,
      files: rows.flatMap(({ path, contents }) =>
        path === null || contents === null ? [] : [{ path, contents }]
      ),
    }
  }

  async save(input: SaveAgentMemoryInput): Promise<SaveAgentMemoryResult> {
    assertSaveAgentMemoryInput(input, "SixbPg")
    return runPgTransaction(this.sql, async (tx) => {
      // A repo's first save has no row to lock, so saves to one repo take its advisory lock.
      await lockAdvisoryKeys(tx, [`agent-memory:${input.projectId}:${input.repoId}`])
      const [{ head } = { head: 0 }] = await tx<{ head: number }[]>`
        SELECT COALESCE(MAX(revision), 0)::int AS head FROM agent_memory_revisions
        WHERE project_id = ${input.projectId} AND repo_id = ${input.repoId}
      `
      const paths = input.changes.map((change) => change.path)
      const latest = await tx<{ path: string; revision: number; contents: string | null }[]>`
        SELECT DISTINCT ON (path) path, revision, contents FROM agent_memory_files
        WHERE project_id = ${input.projectId} AND repo_id = ${input.repoId}
          AND path IN ${tx(paths)}
        ORDER BY path, revision DESC
      `
      const conflicts = agentMemoryConflicts(
        input,
        head,
        new Map(latest.map((file) => [file.path, file]))
      )
      if (conflicts.length > 0) return { saved: false, revision: head, conflicts }

      const revision = head + 1
      const createdAt = input.createdAt ?? new Date()
      await tx`
        INSERT INTO agent_memory_revisions (
          project_id, repo_id, revision, message, author_principal_type, author_principal_id,
          source, created_at
        ) VALUES (
          ${input.projectId}, ${input.repoId}, ${revision}, ${input.message},
          ${input.author.type}, ${input.author.id}, ${input.source ?? null}, ${createdAt}
        )
      `
      await tx`
        INSERT INTO agent_memory_files (project_id, repo_id, path, revision, contents)
        SELECT ${input.projectId}, ${input.repoId}, change.path, ${revision}, change.contents
        FROM jsonb_to_recordset(${JSON.stringify(input.changes)}::text::jsonb)
          AS change(path TEXT, contents TEXT)
      `
      await tx`
        DELETE FROM agent_memory_files AS f
        WHERE f.project_id = ${input.projectId} AND f.repo_id = ${input.repoId}
          AND f.revision IN (
            SELECT revision FROM agent_memory_revisions
            WHERE project_id = ${input.projectId} AND repo_id = ${input.repoId}
              AND created_at < ${agentMemoryHistoryCutoff(createdAt)}
          )
          AND EXISTS (
            SELECT 1 FROM agent_memory_files n
            WHERE n.project_id = f.project_id AND n.repo_id = f.repo_id AND n.path = f.path
              AND n.revision > f.revision
          )
      `
      return { saved: true, revision }
    })
  }

  async listRevisions(
    input: ListAgentMemoryRevisionsInput
  ): Promise<ListAgentMemoryRevisionsResult> {
    return runPgTransaction(
      this.sql,
      async (tx) => {
        const [counted] = await tx<{ total: number }[]>`
          SELECT COUNT(*)::int AS total FROM agent_memory_revisions
          WHERE project_id = ${input.projectId} AND repo_id = ${input.repoId}
        `
        const offset = input.offset ?? 0
        const rows = await tx<RevisionRow[]>`
          SELECT revision, message, author_principal_type, author_principal_id, source, created_at
          FROM agent_memory_revisions
          WHERE project_id = ${input.projectId} AND repo_id = ${input.repoId}
          ORDER BY revision DESC
          LIMIT ${input.limit ?? null} OFFSET ${offset}
        `
        const changes =
          rows.length === 0
            ? []
            : await tx<{ revision: number; path: string; deleted: boolean }[]>`
                SELECT revision, path, contents IS NULL AS deleted FROM agent_memory_files
                WHERE project_id = ${input.projectId} AND repo_id = ${input.repoId}
                  AND revision IN ${tx(rows.map((row) => row.revision))}
                ORDER BY path
              `
        const total = counted?.total ?? 0
        const revisions = rows.map(
          (row): AgentMemoryRevisionRecord => ({
            revision: row.revision,
            message: row.message,
            author: { type: row.author_principal_type, id: row.author_principal_id },
            ...(row.source === null ? {} : { source: row.source }),
            changes: changes
              .filter((change) => change.revision === row.revision)
              .map((change) => ({ path: change.path, deleted: change.deleted })),
            createdAt: new Date(row.created_at),
          })
        )
        return { revisions, hasMore: offset + rows.length < total, total }
      },
      { isolation: "repeatableRead" }
    )
  }

  async delete(input: { projectId: string; repoId: string }): Promise<void> {
    // File versions go with their revisions through ON DELETE CASCADE.
    await this.sql`
      DELETE FROM agent_memory_revisions
      WHERE project_id = ${input.projectId} AND repo_id = ${input.repoId}
    `
  }
}
