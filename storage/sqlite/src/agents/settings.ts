import type { Database } from "bun:sqlite"
import { assertAgentApprovalModeInput } from "@sixb/core/internal/agent-run-storage-provider"
import {
  type AgentApprovalMode,
  type AgentApprovalModeStore,
  AgentStorageError,
  type Principal,
} from "@sixb/core/storage"

export class SqliteAgentApprovalModeStore implements AgentApprovalModeStore {
  constructor(private readonly db: Database) {}

  async getDefault(input: {
    readonly projectId: string
    readonly principal: Principal
  }): Promise<AgentApprovalMode | null> {
    const row = this.db
      .query(
        `SELECT approval_mode FROM agent_user_settings
         WHERE project_id = ? AND principal_type = ? AND principal_id = ?`
      )
      .get(input.projectId, input.principal.type, input.principal.id) as {
      approval_mode: AgentApprovalMode
    } | null
    return row?.approval_mode ?? null
  }

  async setDefault(input: {
    readonly projectId: string
    readonly principal: Principal
    readonly mode: AgentApprovalMode
    readonly updatedAt?: Date
  }): Promise<void> {
    assertAgentApprovalModeInput(input.mode, "SixbSqlite")
    this.db
      .query(
        `INSERT INTO agent_user_settings (
           project_id, principal_type, principal_id, approval_mode, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, principal_type, principal_id)
         DO UPDATE SET approval_mode = excluded.approval_mode, updated_at = excluded.updated_at`
      )
      .run(
        input.projectId,
        input.principal.type,
        input.principal.id,
        input.mode,
        (input.updatedAt ?? new Date()).toISOString()
      )
  }

  async getForThread(input: {
    readonly projectId: string
    readonly threadId: string
    readonly principal: Principal
  }): Promise<AgentApprovalMode | null> {
    const row = this.db
      .query(
        `SELECT approval_mode FROM agent_thread_user_settings
         WHERE project_id = ? AND thread_id = ? AND principal_type = ? AND principal_id = ?`
      )
      .get(input.projectId, input.threadId, input.principal.type, input.principal.id) as {
      approval_mode: AgentApprovalMode
    } | null
    return row?.approval_mode ?? null
  }

  async setForThread(input: {
    readonly projectId: string
    readonly threadId: string
    readonly principal: Principal
    readonly mode: AgentApprovalMode | null
    readonly updatedAt?: Date
  }): Promise<void> {
    if (input.mode !== null) assertAgentApprovalModeInput(input.mode, "SixbSqlite")
    const thread = this.db
      .query("SELECT id FROM agent_threads WHERE project_id = ? AND id = ?")
      .get(input.projectId, input.threadId)
    if (!thread) {
      throw new AgentStorageError(
        "thread_not_found",
        `[SixbSqlite] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
      )
    }

    if (input.mode === null) {
      this.db
        .query(
          `DELETE FROM agent_thread_user_settings
           WHERE project_id = ? AND thread_id = ? AND principal_type = ? AND principal_id = ?`
        )
        .run(input.projectId, input.threadId, input.principal.type, input.principal.id)
      return
    }
    this.db
      .query(
        `INSERT INTO agent_thread_user_settings (
           project_id, thread_id, principal_type, principal_id, approval_mode, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, thread_id, principal_type, principal_id)
         DO UPDATE SET approval_mode = excluded.approval_mode, updated_at = excluded.updated_at`
      )
      .run(
        input.projectId,
        input.threadId,
        input.principal.type,
        input.principal.id,
        input.mode,
        (input.updatedAt ?? new Date()).toISOString()
      )
  }
}
