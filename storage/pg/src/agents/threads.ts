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
import type { SQLClient, SqlParameter } from "../pg-client"
import { isUniqueViolation, isUniqueViolationOf } from "../storage-errors"
import { type PgStoreClient, runPgTransaction } from "../transactions"
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

export class PgAgentThreadStore implements AgentThreadStore {
  constructor(private readonly sql: PgStoreClient) {}

  async transitionSandbox(
    input: TransitionAgentThreadSandboxInput
  ): Promise<AgentThreadSandboxState> {
    return runPgTransaction(this.sql, async (tx) => {
      // Same lock order as run finalization: run, then thread.
      const runs =
        input.action === "recreate"
          ? []
          : await tx<AgentRunRow[]>`
        SELECT * FROM agent_runs WHERE project_id = ${input.projectId} AND id = ${input.runId}
        FOR UPDATE
      `
      const [thread] = await tx<AgentThreadRow[]>`
        SELECT * FROM agent_threads WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `
      const state = transitionAgentThreadSandbox(
        thread ? rowToThreadRecord(thread) : null,
        runs[0] ? rowToRunRecord(runs[0]) : null,
        input
      )
      await tx`UPDATE agent_threads SET sandbox_state = ${JSON.stringify(state)}::text::jsonb
        WHERE project_id = ${input.projectId} AND id = ${input.id}`
      return state
    })
  }

  async create(input: CreateAgentThreadInput): Promise<AgentThreadRecord> {
    const sandboxParams =
      input.sandboxParams === undefined
        ? null
        : JSON.stringify(snapshotAgentThreadSandboxParams(input.sandboxParams))
    const createdAt = input.createdAt ?? new Date()
    const updatedAt = input.updatedAt ?? createdAt

    try {
      const [row] = await this.sql<AgentThreadRow[]>`
        INSERT INTO agent_threads (
          project_id,
          id,
          owner_principal_type,
          owner_principal_id,
          title,
          sandbox_params,
          status,
          created_at,
          updated_at
        ) VALUES (
          ${input.projectId},
          ${input.id},
          ${input.ownerPrincipal.type},
          ${input.ownerPrincipal.id},
          ${input.title ?? null},
          ${sandboxParams}::text::jsonb,
          ${input.status ?? "active"},
          ${createdAt},
          ${updatedAt}
        )
        RETURNING *
      `

      return rowToThreadRecord(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AgentStorageError(
          "duplicate_id",
          `[SixbPg] Agent thread '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      throw error
    }
  }

  async fork(input: ForkAgentThreadInput): Promise<AgentThreadRecord> {
    try {
      return await runPgTransaction(this.sql, async (tx) => {
        // A share lock holds back the writes that take the thread for update: an admitted request
        // or a finalized answer lands before the copy or after it, never inside it.
        const [source] = await tx<Pick<AgentThreadRow, "id" | "active_run_id">[]>`
          SELECT id, active_run_id FROM agent_threads
          WHERE project_id = ${input.projectId} AND id = ${input.sourceThreadId}
          FOR SHARE
        `

        if (!source) {
          throw new AgentStorageError(
            "thread_not_found",
            `[SixbPg] Agent thread '${input.sourceThreadId}' not found for project '${input.projectId}'.`
          )
        }

        const [activeRun] =
          source.active_run_id === null
            ? []
            : await tx<{ trigger_message_id: string | null }[]>`
                SELECT trigger_message_id FROM agent_runs
                WHERE project_id = ${input.projectId} AND id = ${source.active_run_id}
              `

        // Only what the plan needs: the parts are copied by the database, not through here.
        const messages = await tx<Pick<AgentMessageRow, "id" | "seq">[]>`
          SELECT id, seq FROM agent_messages
          WHERE project_id = ${input.projectId} AND thread_id = ${source.id}
          ORDER BY seq ASC
        `
        const checkpoints = await tx<AgentContextCheckpointRow[]>`
          SELECT * FROM agent_context_checkpoints
          WHERE project_id = ${input.projectId} AND thread_id = ${source.id}
          ORDER BY summarized_through_seq DESC, created_at DESC, id DESC
        `

        const plan = planAgentThreadFork(
          input,
          {
            ...(activeRun?.trigger_message_id
              ? { triggerMessageId: activeRun.trigger_message_id }
              : {}),
            messages: messages.map((message) => ({ id: message.id, seq: Number(message.seq) })),
            checkpoints: checkpoints.map(rowToContextCheckpointRecord),
          },
          "SixbPg"
        )
        const { thread } = plan

        const [row] = await tx<AgentThreadRow[]>`
          INSERT INTO agent_threads (
            project_id,
            id,
            owner_principal_type,
            owner_principal_id,
            title,
            sandbox_params,
            sandbox_state,
            status,
            last_message_at,
            message_count,
            created_at,
            updated_at
          ) VALUES (
            ${thread.projectId},
            ${thread.id},
            ${thread.ownerPrincipal.type},
            ${thread.ownerPrincipal.id},
            ${thread.title ?? null},
            ${thread.sandboxParams === undefined ? null : JSON.stringify(thread.sandboxParams)}::text::jsonb,
            ${thread.sandboxState === undefined ? null : JSON.stringify(thread.sandboxState)}::text::jsonb,
            ${thread.status},
            ${thread.lastMessageAt ?? null},
            ${thread.messageCount},
            ${thread.createdAt},
            ${thread.updatedAt}
          )
          RETURNING *
        `

        if (plan.messages.length > 0) {
          await tx`
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
              copy.id,
              ${thread.id},
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
            FROM unnest(
              ${tx.array(plan.messages.map((copy) => copy.sourceId))}::text[],
              ${tx.array(plan.messages.map((copy) => copy.id))}::text[]
            ) AS copy(source_id, id)
            JOIN agent_messages AS message
              ON message.project_id = ${input.projectId} AND message.id = copy.source_id
          `
        }

        if (plan.checkpoint) {
          await insertCopiedCheckpoint(tx, plan.checkpoint)
        }

        return rowToThreadRecord(row)
      })
    } catch (error) {
      if (isUniqueViolationOf(error, "agent_threads_pkey")) {
        throw new AgentStorageError(
          "duplicate_id",
          `[SixbPg] Agent thread '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      throw error
    }
  }

  async getById(params: { projectId: string; id: string }): Promise<AgentThreadRecord | null> {
    const [row] = await this.sql<AgentThreadRow[]>`
      SELECT * FROM agent_threads WHERE project_id = ${params.projectId} AND id = ${params.id}
    `

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

    const rows = await this.sql<AgentThreadRow[]>`
      SELECT *
      FROM agent_threads
      WHERE project_id = ${params.projectId}
        AND id = ANY(${this.sql.array(ids)}::text[])
    `

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

    const whereClauses = ["project_id = $1"]
    const params: SqlParameter[] = [input.projectId]
    let index = 2

    if (input.statuses) {
      const placeholders = input.statuses.map(() => `$${index++}`)
      whereClauses.push(`status IN (${placeholders.join(", ")})`)
      params.push(...input.statuses)
    }

    if (input.ownerPrincipal) {
      whereClauses.push(`owner_principal_type = $${index++} AND owner_principal_id = $${index++}`)
      params.push(input.ownerPrincipal.type, input.ownerPrincipal.id)
    }

    if (input.participantPrincipal) {
      whereClauses.push(`EXISTS (
        SELECT 1 FROM agent_thread_participants participant
        WHERE participant.project_id = agent_threads.project_id
          AND participant.thread_id = agent_threads.id
          AND participant.principal_type = $${index++}
          AND participant.principal_id = $${index++}
      )`)
      params.push(input.participantPrincipal.type, input.participantPrincipal.id)
    }

    const dir = input.order === "asc" ? "ASC" : "DESC"
    const { rows, total, hasMore } = await queryAgentList<AgentThreadRow>({
      sql: this.sql,
      table: "agent_threads",
      whereClauses,
      params,
      nextIndex: index,
      orderBy: `COALESCE(last_message_at, created_at) ${dir}, id ${dir}`,
      limit: input.limit,
      offset: input.offset,
    })

    return { threads: rows.map(rowToThreadRecord), hasMore, total }
  }

  async addParticipants(
    input: AddAgentThreadParticipantsInput
  ): Promise<readonly AgentThreadParticipantRecord[]> {
    return runPgTransaction(this.sql, async (tx) => {
      // Concurrent adds to one thread queue on its row, so the limit counts every participant.
      const [thread] = await tx<{ id: string }[]>`
        SELECT id FROM agent_threads
        WHERE project_id = ${input.projectId} AND id = ${input.threadId}
        FOR UPDATE
      `
      if (!thread) {
        throw new AgentStorageError(
          "thread_not_found",
          `[SixbPg] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
        )
      }

      const existing = await selectParticipants(tx, input.projectId, [input.threadId])
      const added = participantsToAdd(input, existing, "SixbPg")
      const addedAt = input.addedAt ?? new Date()

      for (const principal of added) {
        await tx`
          INSERT INTO agent_thread_participants (
            project_id,
            thread_id,
            principal_type,
            principal_id,
            added_at,
            added_by_type,
            added_by_id
          ) VALUES (
            ${input.projectId},
            ${input.threadId},
            ${principal.type},
            ${principal.id},
            ${addedAt},
            ${input.addedBy.type},
            ${input.addedBy.id}
          )
        `
      }

      return added.length === 0
        ? existing
        : selectParticipants(tx, input.projectId, [input.threadId])
    })
  }

  async removeParticipant(input: RemoveAgentThreadParticipantInput): Promise<boolean> {
    const rows = await this.sql<{ principal_id: string }[]>`
      DELETE FROM agent_thread_participants
      WHERE project_id = ${input.projectId}
        AND thread_id = ${input.threadId}
        AND principal_type = ${input.principal.type}
        AND principal_id = ${input.principal.id}
      RETURNING principal_id
    `

    return rows.length > 0
  }

  async listParticipants(
    input: ListAgentThreadParticipantsInput
  ): Promise<readonly AgentThreadParticipantRecord[]> {
    return selectParticipants(this.sql, input.projectId, [...new Set(input.threadIds)])
  }
}

async function selectParticipants(
  sql: PgStoreClient,
  projectId: string,
  threadIds: readonly string[]
): Promise<AgentThreadParticipantRecord[]> {
  if (threadIds.length === 0) {
    return []
  }

  const rows = await sql<AgentThreadParticipantRow[]>`
    SELECT *
    FROM agent_thread_participants
    WHERE project_id = ${projectId}
      AND thread_id = ANY(${sql.array([...threadIds])}::text[])
    ORDER BY added_at, principal_id COLLATE "C", thread_id COLLATE "C"
  `

  return rows.map(rowToParticipantRecord)
}

async function insertCopiedCheckpoint(
  tx: SQLClient,
  checkpoint: AgentContextCheckpointRecord
): Promise<void> {
  await tx`
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
    ) VALUES (
      ${checkpoint.projectId},
      ${checkpoint.id},
      ${checkpoint.threadId},
      ${checkpoint.createdByRunId},
      ${checkpoint.reason},
      ${checkpoint.summary},
      ${checkpoint.summaryFormatVersion},
      ${checkpoint.summarizedThroughSeq},
      ${checkpoint.observedHeadSeq},
      ${checkpoint.estimatedInputTokensBefore},
      ${checkpoint.estimatedInputTokensAfter},
      ${checkpoint.summaryModelId},
      ${checkpoint.createdAt}
    )
  `
}
