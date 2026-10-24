import { assertAgentApprovalModeInput } from "@sixb/core/internal/agent-run-storage-provider"
import {
  type AgentApprovalMode,
  type AgentApprovalModeStore,
  AgentStorageError,
  type Principal,
} from "@sixb/core/storage"
import { isForeignKeyViolation } from "../storage-errors"
import { type PgStoreClient, runPgTransaction } from "../transactions"

export class PgAgentApprovalModeStore implements AgentApprovalModeStore {
  constructor(private readonly sql: PgStoreClient) {}

  async getDefault(input: {
    readonly projectId: string
    readonly principal: Principal
  }): Promise<AgentApprovalMode | null> {
    const [row] = await this.sql<{ approval_mode: AgentApprovalMode }[]>`
      SELECT approval_mode FROM agent_user_settings
      WHERE project_id = ${input.projectId} AND principal_type = ${input.principal.type}
        AND principal_id = ${input.principal.id}
    `
    return row?.approval_mode ?? null
  }

  async setDefault(input: {
    readonly projectId: string
    readonly principal: Principal
    readonly mode: AgentApprovalMode
    readonly updatedAt?: Date
  }): Promise<void> {
    assertAgentApprovalModeInput(input.mode, "SixbPg")
    await this.sql`
      INSERT INTO agent_user_settings (
        project_id, principal_type, principal_id, approval_mode, updated_at
      ) VALUES (
        ${input.projectId}, ${input.principal.type}, ${input.principal.id}, ${input.mode},
        ${input.updatedAt ?? new Date()}
      )
      ON CONFLICT (project_id, principal_type, principal_id)
      DO UPDATE SET approval_mode = EXCLUDED.approval_mode, updated_at = EXCLUDED.updated_at
    `
  }

  async getForThread(input: {
    readonly projectId: string
    readonly threadId: string
    readonly principal: Principal
  }): Promise<AgentApprovalMode | null> {
    const [row] = await this.sql<{ approval_mode: AgentApprovalMode }[]>`
      SELECT approval_mode FROM agent_thread_user_settings
      WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
        AND principal_type = ${input.principal.type} AND principal_id = ${input.principal.id}
    `
    return row?.approval_mode ?? null
  }

  async setForThread(input: {
    readonly projectId: string
    readonly threadId: string
    readonly principal: Principal
    readonly mode: AgentApprovalMode | null
    readonly updatedAt?: Date
  }): Promise<void> {
    if (input.mode !== null) assertAgentApprovalModeInput(input.mode, "SixbPg")
    try {
      await runPgTransaction(this.sql, async (tx) => {
        const [thread] = await tx<{ id: string }[]>`
          SELECT id FROM agent_threads
          WHERE project_id = ${input.projectId} AND id = ${input.threadId}
        `
        if (!thread) throw threadNotFound(input)
        if (input.mode === null) {
          await tx`
            DELETE FROM agent_thread_user_settings
            WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
              AND principal_type = ${input.principal.type} AND principal_id = ${input.principal.id}
          `
          return
        }
        await tx`
          INSERT INTO agent_thread_user_settings (
            project_id, thread_id, principal_type, principal_id, approval_mode, updated_at
          ) VALUES (
            ${input.projectId}, ${input.threadId}, ${input.principal.type}, ${input.principal.id},
            ${input.mode}, ${input.updatedAt ?? new Date()}
          )
          ON CONFLICT (project_id, thread_id, principal_type, principal_id)
          DO UPDATE SET approval_mode = EXCLUDED.approval_mode, updated_at = EXCLUDED.updated_at
        `
      })
    } catch (error) {
      // A thread deleted between the read and the insert.
      if (!isForeignKeyViolation(error)) throw error
      throw threadNotFound(input)
    }
  }
}

function threadNotFound(input: { readonly projectId: string; readonly threadId: string }) {
  return new AgentStorageError(
    "thread_not_found",
    `[SixbPg] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
  )
}
