import type { Database } from "bun:sqlite"
import type { Principal } from "@sixb/core"
import {
  agentMemoryConflicts,
  agentMemoryHistoryCutoff,
  assertSaveAgentMemoryInput,
  type LatestAgentMemoryFile,
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
import { runImmediateTransaction } from "../transactions"

interface RevisionRow {
  readonly revision: number
  readonly message: string
  readonly author_principal_type: Principal["type"]
  readonly author_principal_id: string
  readonly source: string | null
  readonly created_at: string
}

/** Each path's highest-revision version, the deleted ones included. */
const LATEST_FILES = `
  SELECT f.path, f.revision, f.contents FROM agent_memory_files f
  WHERE f.project_id = ? AND f.repo_id = ? AND f.revision = (
    SELECT MAX(l.revision) FROM agent_memory_files l
    WHERE l.project_id = f.project_id AND l.repo_id = f.repo_id AND l.path = f.path
  )
`

export class SqliteAgentMemoryStore implements AgentMemoryStore {
  constructor(private readonly db: Database) {}

  async get(input: { projectId: string; repoId: string }): Promise<AgentMemoryRepoRecord> {
    return this.db.transaction(() => {
      const files = this.db
        .query(`${LATEST_FILES} AND f.contents IS NOT NULL ORDER BY f.path`)
        .all(input.projectId, input.repoId) as { path: string; contents: string }[]
      return {
        revision: this.head(input.projectId, input.repoId),
        files: files.map(({ path, contents }) => ({ path, contents })),
      }
    })()
  }

  async save(input: SaveAgentMemoryInput): Promise<SaveAgentMemoryResult> {
    assertSaveAgentMemoryInput(input, "SixbSqlite")
    return runImmediateTransaction(this.db, () => {
      const head = this.head(input.projectId, input.repoId)
      const paths = input.changes.map((change) => change.path)
      const latest = this.db
        .query(`${LATEST_FILES} AND f.path IN (${paths.map(() => "?").join(", ")})`)
        .all(input.projectId, input.repoId, ...paths) as (LatestAgentMemoryFile & {
        path: string
      })[]
      const conflicts = agentMemoryConflicts(
        input,
        head,
        new Map(latest.map((file) => [file.path, file]))
      )
      if (conflicts.length > 0) return { saved: false, revision: head, conflicts }

      const revision = head + 1
      const createdAt = input.createdAt ?? new Date()
      this.db
        .query(
          `INSERT INTO agent_memory_revisions (
            project_id, repo_id, revision, message, author_principal_type, author_principal_id,
            source, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.projectId,
          input.repoId,
          revision,
          input.message,
          input.author.type,
          input.author.id,
          input.source ?? null,
          createdAt.toISOString()
        )
      const insertFile = this.db.query(
        `INSERT INTO agent_memory_files (project_id, repo_id, path, revision, contents)
         VALUES (?, ?, ?, ?, ?)`
      )
      for (const change of input.changes) {
        insertFile.run(input.projectId, input.repoId, change.path, revision, change.contents)
      }
      this.db
        .query(
          `DELETE FROM agent_memory_files AS f
           WHERE f.project_id = ? AND f.repo_id = ? AND f.revision IN (
             SELECT revision FROM agent_memory_revisions
             WHERE project_id = ? AND repo_id = ? AND created_at < ?
           ) AND EXISTS (
             SELECT 1 FROM agent_memory_files n
             WHERE n.project_id = f.project_id AND n.repo_id = f.repo_id AND n.path = f.path
               AND n.revision > f.revision
           )`
        )
        .run(
          input.projectId,
          input.repoId,
          input.projectId,
          input.repoId,
          agentMemoryHistoryCutoff(createdAt).toISOString()
        )
      return { saved: true, revision }
    })
  }

  async listRevisions(
    input: ListAgentMemoryRevisionsInput
  ): Promise<ListAgentMemoryRevisionsResult> {
    return this.db.transaction(() => {
      const { total } = this.db
        .query(
          "SELECT COUNT(*) AS total FROM agent_memory_revisions WHERE project_id = ? AND repo_id = ?"
        )
        .get(input.projectId, input.repoId) as { total: number }
      const offset = input.offset ?? 0
      const rows = this.db
        .query(
          `SELECT revision, message, author_principal_type, author_principal_id, source, created_at
           FROM agent_memory_revisions WHERE project_id = ? AND repo_id = ?
           ORDER BY revision DESC LIMIT ? OFFSET ?`
        )
        .all(input.projectId, input.repoId, input.limit ?? -1, offset) as RevisionRow[]
      const changes = this.db
        .query(
          `SELECT revision, path, contents IS NULL AS deleted FROM agent_memory_files
           WHERE project_id = ? AND repo_id = ? AND revision IN (${rows.map(() => "?").join(", ")})
           ORDER BY path`
        )
        .all(input.projectId, input.repoId, ...rows.map((row) => row.revision)) as {
        revision: number
        path: string
        deleted: number
      }[]
      const revisions = rows.map(
        (row): AgentMemoryRevisionRecord => ({
          revision: row.revision,
          message: row.message,
          author: { type: row.author_principal_type, id: row.author_principal_id },
          ...(row.source === null ? {} : { source: row.source }),
          changes: changes
            .filter((change) => change.revision === row.revision)
            .map((change) => ({ path: change.path, deleted: change.deleted === 1 })),
          createdAt: new Date(row.created_at),
        })
      )
      return { revisions, hasMore: offset + rows.length < total, total }
    })()
  }

  async delete(input: { projectId: string; repoId: string }): Promise<void> {
    // File versions go with their revisions through ON DELETE CASCADE.
    this.db
      .query("DELETE FROM agent_memory_revisions WHERE project_id = ? AND repo_id = ?")
      .run(input.projectId, input.repoId)
  }

  private head(projectId: string, repoId: string): number {
    const row = this.db
      .query(
        `SELECT COALESCE(MAX(revision), 0) AS revision FROM agent_memory_revisions
         WHERE project_id = ? AND repo_id = ?`
      )
      .get(projectId, repoId) as { revision: number }
    return row.revision
  }
}
