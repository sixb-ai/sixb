import type { Database } from "bun:sqlite"
import {
  participantsToAdd,
  snapshotAgentThreadSandboxParams,
  transitionAgentThreadSandbox,
} from "@sixb/core/internal/agent-run-storage-provider"
import {
  type AddAgentThreadParticipantsInput,
  AgentStorageError,
  type AgentThreadParticipantRecord,
  type AgentThreadRecord,
  type AgentThreadSandboxState,
  type AgentThreadStore,
  type CreateAgentThreadInput,
  type ListAgentThreadParticipantsInput,
  type ListAgentThreadsInput,
  type ListAgentThreadsResult,
  type RemoveAgentThreadParticipantInput,
  type TransitionAgentThreadSandboxInput,
} from "@sixb/core/storage"
import type { SqliteValue } from "../run-list-query"
import { isUniqueConstraintError } from "../storage-errors"
import {
  type AgentRunRow,
  type AgentThreadParticipantRow,
  type AgentThreadRow,
  queryAgentList,
  rowToParticipantRecord,
  rowToRunRecord,
  rowToThreadRecord,
} from "./rows"

export class SqliteAgentThreadStore implements AgentThreadStore {
  constructor(private readonly db: Database) {}

  async transitionSandbox(
    input: TransitionAgentThreadSandboxInput
  ): Promise<AgentThreadSandboxState> {
    return this.db
      .transaction(() => {
        const run =
          input.action === "recreate"
            ? null
            : (this.db
                .query("SELECT * FROM agent_runs WHERE project_id = ? AND id = ?")
                .get(input.projectId, input.runId) as AgentRunRow | null)
        const thread = this.requireThread(input.projectId, input.id)
        const state = transitionAgentThreadSandbox(thread, run ? rowToRunRecord(run) : null, input)
        this.db
          .query("UPDATE agent_threads SET sandbox_state = ? WHERE project_id = ? AND id = ?")
          .run(JSON.stringify(state), input.projectId, input.id)
        return state
      })
      .immediate()
  }

  async create(input: CreateAgentThreadInput): Promise<AgentThreadRecord> {
    const sandboxParams =
      input.sandboxParams === undefined
        ? null
        : JSON.stringify(snapshotAgentThreadSandboxParams(input.sandboxParams))
    const createdAt = input.createdAt ?? new Date()
    const updatedAt = input.updatedAt ?? createdAt

    try {
      this.db
        .query(
          `
          INSERT INTO agent_threads (
            project_id,
            id,
            owner_principal_type,
            owner_principal_id,
            title,
            sandbox_params,
            status,
            active_run_id,
            last_message_at,
            message_count,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)
        `
        )
        .run(
          input.projectId,
          input.id,
          input.ownerPrincipal.type,
          input.ownerPrincipal.id,
          input.title ?? null,
          sandboxParams,
          input.status ?? "active",
          createdAt.toISOString(),
          updatedAt.toISOString()
        )
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AgentStorageError(
          "duplicate_id",
          `[SixbSqlite] Agent thread '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      throw error
    }

    return this.requireThread(input.projectId, input.id)
  }

  async getById(params: { projectId: string; id: string }): Promise<AgentThreadRecord | null> {
    const row = this.db
      .query("SELECT * FROM agent_threads WHERE project_id = ? AND id = ?")
      .get(params.projectId, params.id) as AgentThreadRow | null

    return row ? rowToThreadRecord(row) : null
  }

  async getByIds(params: {
    readonly projectId: string
    readonly ids: readonly string[]
  }): Promise<readonly AgentThreadRecord[]> {
    const ids = [...new Set(params.ids)]
    if (ids.length === 0) {
      return []
    }

    const rows = this.db
      .query(
        `
        SELECT *
        FROM agent_threads
        WHERE project_id = ?
          AND id IN (SELECT value FROM json_each(?))
      `
      )
      .all(params.projectId, JSON.stringify(ids)) as AgentThreadRow[]

    const byId = new Map(rows.map((row) => [row.id, row]))
    return ids.flatMap((id) => {
      const row = byId.get(id)
      return row ? [rowToThreadRecord(row)] : []
    })
  }

  async list(input: ListAgentThreadsInput): Promise<ListAgentThreadsResult> {
    if (input.statuses !== undefined && input.statuses.length === 0) {
      return { threads: [], hasMore: false, total: 0 }
    }

    const whereClauses = ["project_id = ?"]
    const args: SqliteValue[] = [input.projectId]

    if (input.statuses) {
      whereClauses.push(`status IN (${input.statuses.map(() => "?").join(", ")})`)
      args.push(...input.statuses)
    }

    if (input.ownerPrincipal) {
      whereClauses.push("owner_principal_type = ? AND owner_principal_id = ?")
      args.push(input.ownerPrincipal.type, input.ownerPrincipal.id)
    }

    if (input.participantPrincipal) {
      whereClauses.push(`EXISTS (
        SELECT 1 FROM agent_thread_participants participant
        WHERE participant.project_id = agent_threads.project_id
          AND participant.thread_id = agent_threads.id
          AND participant.principal_type = ?
          AND participant.principal_id = ?
      )`)
      args.push(input.participantPrincipal.type, input.participantPrincipal.id)
    }

    const dir = input.order === "asc" ? "ASC" : "DESC"
    const { rows, total, hasMore } = queryAgentList<AgentThreadRow>({
      db: this.db,
      table: "agent_threads",
      whereClauses,
      args,
      orderBy: `COALESCE(last_message_at, created_at) ${dir}, id ${dir}`,
      limit: input.limit,
      offset: input.offset,
    })

    return { threads: rows.map(rowToThreadRecord), hasMore, total }
  }

  async addParticipants(
    input: AddAgentThreadParticipantsInput
  ): Promise<readonly AgentThreadParticipantRecord[]> {
    return this.db
      .transaction(() => {
        const thread = this.db
          .query("SELECT id FROM agent_threads WHERE project_id = ? AND id = ?")
          .get(input.projectId, input.threadId)
        if (!thread) {
          throw new AgentStorageError(
            "thread_not_found",
            `[SixbSqlite] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
          )
        }

        const existing = this.selectParticipants(input.projectId, [input.threadId])
        const added = participantsToAdd(input, existing, "SixbSqlite")
        const addedAt = (input.addedAt ?? new Date()).toISOString()

        const insert = this.db.query(`
          INSERT INTO agent_thread_participants (
            project_id,
            thread_id,
            principal_type,
            principal_id,
            added_at,
            added_by_type,
            added_by_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        for (const principal of added) {
          insert.run(
            input.projectId,
            input.threadId,
            principal.type,
            principal.id,
            addedAt,
            input.addedBy.type,
            input.addedBy.id
          )
        }

        return added.length === 0
          ? existing
          : this.selectParticipants(input.projectId, [input.threadId])
      })
      .immediate()
  }

  async removeParticipant(input: RemoveAgentThreadParticipantInput): Promise<boolean> {
    const result = this.db
      .query(`
        DELETE FROM agent_thread_participants
        WHERE project_id = ? AND thread_id = ? AND principal_type = ? AND principal_id = ?
      `)
      .run(input.projectId, input.threadId, input.principal.type, input.principal.id)

    return result.changes > 0
  }

  async listParticipants(
    input: ListAgentThreadParticipantsInput
  ): Promise<readonly AgentThreadParticipantRecord[]> {
    return this.selectParticipants(input.projectId, [...new Set(input.threadIds)])
  }

  private selectParticipants(
    projectId: string,
    threadIds: readonly string[]
  ): AgentThreadParticipantRecord[] {
    if (threadIds.length === 0) {
      return []
    }

    const rows = this.db
      .query(`
        SELECT *
        FROM agent_thread_participants
        WHERE project_id = ?
          AND thread_id IN (SELECT value FROM json_each(?))
        ORDER BY added_at, principal_id, thread_id
      `)
      .all(projectId, JSON.stringify(threadIds)) as AgentThreadParticipantRow[]

    return rows.map(rowToParticipantRecord)
  }

  private requireThread(projectId: string, id: string): AgentThreadRecord {
    const row = this.db
      .query("SELECT * FROM agent_threads WHERE project_id = ? AND id = ?")
      .get(projectId, id) as AgentThreadRow | null

    if (!row) {
      throw new AgentStorageError(
        "invalid_state",
        `[SixbSqlite] Failed to load agent thread '${id}' for project '${projectId}'.`
      )
    }

    return rowToThreadRecord(row)
  }
}
