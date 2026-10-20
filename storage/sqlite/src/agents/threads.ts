import type { Database } from "bun:sqlite"
import {
  participantsToAdd,
  planAgentThreadFork,
  snapshotAgentThreadSandboxParams,
  transitionAgentThreadSandbox,
} from "@sixb/core/internal/agent-run-storage-provider"
import {
  type AddAgentThreadParticipantsInput,
  type AgentContextCheckpointRecord,
  AgentStorageError,
  type AgentThreadParticipantRecord,
  type AgentThreadRecord,
  type AgentThreadSandboxState,
  type AgentThreadStore,
  type CreateAgentThreadInput,
  type ForkAgentThreadInput,
  type ListAgentThreadParticipantsInput,
  type ListAgentThreadsInput,
  type ListAgentThreadsResult,
  type RemoveAgentThreadParticipantInput,
  type TransitionAgentThreadSandboxInput,
} from "@sixb/core/storage"
import type { SqliteValue } from "../run-list-query"
import { isUniqueConstraintError } from "../storage-errors"
import {
  type AgentContextCheckpointRow,
  type AgentMessageRow,
  type AgentRunRow,
  type AgentThreadParticipantRow,
  type AgentThreadRow,
  queryAgentList,
  rowToContextCheckpointRecord,
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

  async fork(input: ForkAgentThreadInput): Promise<AgentThreadRecord> {
    return this.db
      .transaction(() => {
        const source = this.db
          .query("SELECT id, active_run_id FROM agent_threads WHERE project_id = ? AND id = ?")
          .get(input.projectId, input.sourceThreadId) as Pick<
          AgentThreadRow,
          "id" | "active_run_id"
        > | null

        if (!source) {
          throw new AgentStorageError(
            "thread_not_found",
            `[SixbSqlite] Agent thread '${input.sourceThreadId}' not found for project '${input.projectId}'.`
          )
        }

        const activeRun = source.active_run_id === null ? null : this.findActiveRun(input, source)

        // Only what the plan needs: the parts are copied by the database, not through here.
        const messages = this.db
          .query(
            "SELECT id, seq FROM agent_messages WHERE project_id = ? AND thread_id = ? ORDER BY seq ASC"
          )
          .all(input.projectId, source.id) as Pick<AgentMessageRow, "id" | "seq">[]

        const checkpoints = this.db
          .query(
            `
            SELECT * FROM agent_context_checkpoints
            WHERE project_id = ? AND thread_id = ?
            ORDER BY summarized_through_seq DESC, created_at DESC, id DESC
          `
          )
          .all(input.projectId, source.id) as AgentContextCheckpointRow[]

        const plan = planAgentThreadFork(
          input,
          {
            ...(activeRun?.trigger_message_id
              ? { triggerMessageId: activeRun.trigger_message_id }
              : {}),
            messages,
            checkpoints: checkpoints.map(rowToContextCheckpointRecord),
          },
          "SixbSqlite"
        )

        this.insertForkedThread(plan.thread)

        this.db
          .query(
            `
            INSERT INTO agent_messages (
              project_id,
              id,
              thread_id,
              run_id,
              role,
              author_principal_type,
              author_principal_id,
              seq,
              parts,
              metadata,
              content_version,
              created_at,
              completed_at
            )
            SELECT
              message.project_id,
              json_extract(copy.value, '$[1]'),
              ?,
              message.run_id,
              message.role,
              message.author_principal_type,
              message.author_principal_id,
              message.seq,
              message.parts,
              message.metadata,
              message.content_version,
              message.created_at,
              message.completed_at
            FROM json_each(?) AS copy
            JOIN agent_messages AS message
              ON message.project_id = ? AND message.id = json_extract(copy.value, '$[0]')
          `
          )
          .run(
            plan.thread.id,
            JSON.stringify(plan.messages.map((copy) => [copy.sourceId, copy.id])),
            input.projectId
          )

        if (plan.checkpoint) {
          this.insertCopiedCheckpoint(plan.checkpoint)
        }

        return this.requireThread(input.projectId, input.id)
      })
      .immediate()
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

  private findActiveRun(
    input: ForkAgentThreadInput,
    source: Pick<AgentThreadRow, "active_run_id">
  ): Pick<AgentRunRow, "trigger_message_id"> | null {
    return this.db
      .query("SELECT trigger_message_id FROM agent_runs WHERE project_id = ? AND id = ?")
      .get(input.projectId, source.active_run_id) as Pick<AgentRunRow, "trigger_message_id"> | null
  }

  private insertForkedThread(thread: AgentThreadRecord): void {
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
            sandbox_state,
            status,
            active_run_id,
            last_message_at,
            message_count,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
        `
        )
        .run(
          thread.projectId,
          thread.id,
          thread.ownerPrincipal.type,
          thread.ownerPrincipal.id,
          thread.title ?? null,
          thread.sandboxParams === undefined ? null : JSON.stringify(thread.sandboxParams),
          thread.sandboxState === undefined ? null : JSON.stringify(thread.sandboxState),
          thread.status,
          thread.lastMessageAt?.toISOString() ?? null,
          thread.messageCount,
          thread.createdAt.toISOString(),
          thread.updatedAt.toISOString()
        )
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AgentStorageError(
          "duplicate_id",
          `[SixbSqlite] Agent thread '${thread.id}' already exists for project '${thread.projectId}'.`
        )
      }

      throw error
    }
  }

  private insertCopiedCheckpoint(checkpoint: AgentContextCheckpointRecord): void {
    this.db
      .query(
        `
        INSERT INTO agent_context_checkpoints (
          project_id,
          id,
          thread_id,
          created_by_run_id,
          reason,
          summary,
          summary_format_version,
          summarized_through_seq,
          observed_head_seq,
          estimated_input_tokens_before,
          estimated_input_tokens_after,
          summary_model_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        checkpoint.projectId,
        checkpoint.id,
        checkpoint.threadId,
        checkpoint.createdByRunId,
        checkpoint.reason,
        checkpoint.summary,
        checkpoint.summaryFormatVersion,
        checkpoint.summarizedThroughSeq,
        checkpoint.observedHeadSeq,
        checkpoint.estimatedInputTokensBefore,
        checkpoint.estimatedInputTokensAfter,
        checkpoint.summaryModelId,
        checkpoint.createdAt.toISOString()
      )
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
