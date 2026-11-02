import type { Database } from "bun:sqlite"
import {
  assertAgentThreadComputer,
  assertAssignableComputer,
  assertComputerPlace,
  assertConversationThreadRow,
  assertMovableToCloud,
  movesComputerPlace,
  participantsToAdd,
  planAgentThreadFork,
  queuedTurnInCloud,
  remapArtifactIds,
  snapshotAgentThreadSandboxParams,
  transitionAgentThreadSandbox,
} from "@sixb/core/internal/agent-run-storage-provider"
import {
  type AddAgentThreadParticipantsInput,
  type AgentContextCheckpointRecord,
  type AgentRunRecord,
  AgentStorageError,
  type AgentThreadParticipantRecord,
  type AgentThreadRecord,
  type AgentThreadSandboxState,
  type AgentThreadStore,
  type AssignAgentThreadComputerInput,
  type CreateAgentThreadInput,
  type ForkAgentThreadInput,
  type ListAgentThreadChildrenInput,
  type ListAgentThreadParticipantsInput,
  type ListAgentThreadsInput,
  type ListAgentThreadsResult,
  type MoveAgentThreadToCloudInput,
  type MoveAgentThreadToCloudResult,
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
    assertComputerPlace(input.runsOn, input.computer, "SixbSqlite")
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
            runs_on,
            computer_id,
            computer_name,
            computer_folder,
            status,
            active_run_id,
            last_message_at,
            message_count,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)
        `
        )
        .run(
          input.projectId,
          input.id,
          input.ownerPrincipal.type,
          input.ownerPrincipal.id,
          input.title ?? null,
          sandboxParams,
          input.runsOn ?? null,
          input.computer?.id ?? null,
          input.computer?.name ?? null,
          input.computer?.folder ?? null,
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

  private activeRunOf(projectId: string, thread: AgentThreadRecord | null): AgentRunRecord | null {
    const row = thread?.activeRunId
      ? (this.db
          .query("SELECT * FROM agent_runs WHERE project_id = ? AND id = ?")
          .get(projectId, thread.activeRunId) as AgentRunRow | null)
      : null
    return row ? rowToRunRecord(row) : null
  }

  async fork(input: ForkAgentThreadInput): Promise<AgentThreadRecord> {
    return this.db
      .transaction(() => {
        const source = this.db
          .query(
            "SELECT id, kind, active_run_id, runs_on, moved_at FROM agent_threads WHERE project_id = ? AND id = ?"
          )
          .get(input.projectId, input.sourceThreadId) as Pick<
          AgentThreadRow,
          "id" | "kind" | "active_run_id" | "runs_on" | "moved_at"
        > | null

        if (!source) {
          throw new AgentStorageError(
            "thread_not_found",
            `[SixbSqlite] Agent thread '${input.sourceThreadId}' not found for project '${input.projectId}'.`
          )
        }
        assertConversationThreadRow(source, "can be forked", "SixbSqlite")

        const activeRun = source.active_run_id === null ? null : this.findActiveRun(input, source)

        // Only what the plan needs: the parts are copied by the database, not through here. A
        // message of approval outcomes only is not counted (`countsAsThreadMessage`).
        const messages = (
          this.db
            .query(
              `
              SELECT id, seq,
                NOT (
                  json_array_length(parts) > 0 AND NOT EXISTS (
                    SELECT 1 FROM json_each(agent_messages.parts)
                    WHERE json_extract(value, '$.type') <> 'approval-outcome'
                  )
                ) AS counted
              FROM agent_messages WHERE project_id = ? AND thread_id = ? ORDER BY seq ASC
            `
            )
            .all(input.projectId, source.id) as (Pick<AgentMessageRow, "id" | "seq"> & {
            counted: number
          })[]
        ).map((row) => ({ id: row.id, seq: row.seq, counted: row.counted === 1 }))

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
            workspace: { runsOn: source.runs_on, movedAt: source.moved_at },
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
        this.remapCopiedParts(
          input.projectId,
          plan.messages.map((copy) => copy.id),
          input.artifactCopies
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

  async listChildren(input: ListAgentThreadChildrenInput): Promise<readonly AgentThreadRecord[]> {
    // By `idx_agent_threads_children`, which holds sub-agents' threads only.
    const turn = input.parentRunId === undefined ? "" : "AND parent_run_id = ?"
    const rows = this.db
      .query(
        `
        SELECT *
        FROM agent_threads
        WHERE project_id = ? AND parent_thread_id = ? AND kind = 'subagent' ${turn}
        ORDER BY created_at ASC, id ASC
        LIMIT ? OFFSET ?
      `
      )
      .all(
        input.projectId,
        input.parentThreadId,
        ...(input.parentRunId === undefined ? [] : [input.parentRunId]),
        input.limit ?? 100,
        input.offset ?? 0
      ) as AgentThreadRow[]
    return rows.map(rowToThreadRecord)
  }

  async list(input: ListAgentThreadsInput): Promise<ListAgentThreadsResult> {
    if (input.statuses !== undefined && input.statuses.length === 0) {
      return { threads: [], hasMore: false, total: 0 }
    }

    // A sub-agent's thread is read through its conversation; the list indexes leave it out too.
    const whereClauses = ["project_id = ?", "kind = 'conversation'"]
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

    if (input.activeOnComputer) {
      whereClauses.push("computer_id = ? AND computer_folder = ? AND active_run_id IS NOT NULL")
      args.push(input.activeOnComputer.id, input.activeOnComputer.folder)
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
          .query("SELECT id, kind FROM agent_threads WHERE project_id = ? AND id = ?")
          .get(input.projectId, input.threadId) as Pick<AgentThreadRow, "id" | "kind"> | null
        if (!thread) {
          throw new AgentStorageError(
            "thread_not_found",
            `[SixbSqlite] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
          )
        }
        assertConversationThreadRow(thread, "has participants", "SixbSqlite")

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

  async assignComputer(input: AssignAgentThreadComputerInput): Promise<AgentThreadRecord> {
    assertAgentThreadComputer(input.computer, "SixbSqlite")
    return this.db
      .transaction(() => {
        const row = this.db
          .query("SELECT * FROM agent_threads WHERE project_id = ? AND id = ?")
          .get(input.projectId, input.id) as AgentThreadRow | null
        const thread = row ? rowToThreadRecord(row) : null
        assertAssignableComputer(
          thread,
          this.activeRunOf(input.projectId, thread),
          input.computer,
          input.id,
          "SixbSqlite"
        )
        const movedAt = movesComputerPlace(thread, input.computer)
          ? (input.movedAt ?? new Date()).toISOString()
          : null
        this.db
          .query(`
            UPDATE agent_threads
            SET computer_id = ?, computer_name = ?, computer_folder = ?,
              moved_at = COALESCE(?, moved_at)
            WHERE project_id = ? AND id = ?
          `)
          .run(
            input.computer.id,
            input.computer.name,
            input.computer.folder,
            movedAt,
            input.projectId,
            input.id
          )
        return this.requireThread(input.projectId, input.id)
      })
      .immediate()
  }

  async moveToCloud(input: MoveAgentThreadToCloudInput): Promise<MoveAgentThreadToCloudResult> {
    return this.db
      .transaction(() => {
        const row = this.db
          .query("SELECT * FROM agent_threads WHERE project_id = ? AND id = ?")
          .get(input.projectId, input.id) as AgentThreadRow | null
        const thread = row ? rowToThreadRecord(row) : null
        const active = this.activeRunOf(input.projectId, thread)
        assertMovableToCloud(thread, active, input.id, "SixbSqlite")

        const queued = queuedTurnInCloud(active)
        if (queued) {
          this.db
            .query("UPDATE agent_runs SET spec = ? WHERE project_id = ? AND id = ?")
            .run(JSON.stringify(queued.spec), input.projectId, queued.id)
        }
        this.db
          .query(`
            UPDATE agent_threads
            SET runs_on = NULL, computer_id = NULL, computer_name = NULL, computer_folder = NULL,
              moved_at = ?
            WHERE project_id = ? AND id = ?
          `)
          .run((input.movedAt ?? new Date()).toISOString(), input.projectId, input.id)
        const moved = this.requireThread(input.projectId, input.id)
        return { thread: moved, ...(queued ? { queued } : {}) }
      })
      .immediate()
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
            moved_at,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
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
          thread.movedAt?.toISOString() ?? null,
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

  /** The copied messages name the fork's copies of the source's artifacts. */
  private remapCopiedParts(
    projectId: string,
    messageIds: readonly string[],
    copies: Readonly<Record<string, string>> | undefined
  ): void {
    if (!copies || Object.keys(copies).length === 0 || messageIds.length === 0) return

    const rows = this.db
      .query(
        `SELECT id, parts FROM agent_messages
         WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))`
      )
      .all(projectId, JSON.stringify(messageIds)) as {
      readonly id: string
      readonly parts: string
    }[]
    const update = this.db.query(
      "UPDATE agent_messages SET parts = ? WHERE project_id = ? AND id = ?"
    )
    for (const row of rows) {
      const parts = remapArtifactIds(row.parts, copies)
      if (parts !== row.parts) update.run(parts, projectId, row.id)
    }
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
