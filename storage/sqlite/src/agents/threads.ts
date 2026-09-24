import type { Database } from "bun:sqlite"
import {
  snapshotAgentThreadSandboxParams,
  transitionAgentThreadSandbox,
} from "@sixb/core/internal/agent-run-storage-provider"
import {
  AgentStorageError,
  type AgentThreadRecord,
  type AgentThreadSandboxState,
  type AgentThreadStore,
  type CreateAgentThreadInput,
  type ListAgentThreadsInput,
  type ListAgentThreadsResult,
  type TransitionAgentThreadSandboxInput,
} from "@sixb/core/storage"
import type { SqliteValue } from "../run-list-query"
import { isUniqueConstraintError } from "../storage-errors"
import {
  type AgentRunRow,
  type AgentThreadRow,
  queryAgentList,
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
