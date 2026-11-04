import {
  AGENT_COMPUTER_BACKGROUND_COMMANDS_MAX,
  assertAgentBackgroundCommandRef,
  assertAgentComputerSession,
} from "@sixb/core/internal/agent-run-storage-provider"
import type {
  AgentBackgroundCommandRef,
  AgentComputerBackgroundCommand,
  AgentComputerSessionRecord,
  AgentComputerSessionStore,
  Principal,
} from "@sixb/core/storage"
import type { PgStoreClient } from "../transactions"

interface AgentComputerSessionRow {
  project_id: string
  owner_principal_type: Principal["type"]
  owner_principal_id: string
  id: string
  computer_id: string
  computer_name: string
  folder: string
  expires_at: Date | string
  background_commands: readonly AgentComputerBackgroundCommand[]
  stop_requests: readonly AgentBackgroundCommandRef[]
}

export class PgAgentComputerSessionStore implements AgentComputerSessionStore {
  constructor(private readonly sql: PgStoreClient) {}

  async hold(input: Omit<AgentComputerSessionRecord, "stopRequests">): Promise<void> {
    assertAgentComputerSession(input, "SixbPg")
    const background = JSON.stringify(input.backgroundCommands ?? [])
    await this.sql`
      INSERT INTO agent_computer_sessions (
        project_id, owner_principal_type, owner_principal_id, id,
        computer_id, computer_name, folder, expires_at, background_commands
      ) VALUES (
        ${input.projectId}, ${input.ownerPrincipal.type}, ${input.ownerPrincipal.id}, ${input.id},
        ${input.computer.id}, ${input.computer.name}, ${input.computer.folder}, ${input.expiresAt},
        ${background}::text::jsonb
      )
      ON CONFLICT (project_id, owner_principal_type, owner_principal_id, id)
      DO UPDATE SET
        computer_id = excluded.computer_id,
        computer_name = excluded.computer_name,
        folder = excluded.folder,
        expires_at = excluded.expires_at,
        background_commands = excluded.background_commands
    `
  }

  async requestStop(input: {
    readonly projectId: string
    readonly id: string
    readonly ownerPrincipal: Principal
    readonly command: AgentBackgroundCommandRef
  }): Promise<AgentComputerSessionRecord | null> {
    assertAgentBackgroundCommandRef(input.command, "SixbPg")
    const { threadId, id, startedAt } = input.command
    const ref = JSON.stringify({ threadId, id, startedAt })
    // Added once, at the end, keeping the newest: in one statement, as two stops may race.
    const [row] = await this.sql<AgentComputerSessionRow[]>`
      UPDATE agent_computer_sessions AS session
      SET stop_requests = (
        SELECT COALESCE(jsonb_agg(kept.value ORDER BY kept.position), '[]'::jsonb)
        FROM (
          SELECT request.value, request.position
          FROM jsonb_array_elements(
            CASE
              WHEN session.stop_requests @> jsonb_build_array(${ref}::text::jsonb)
                THEN session.stop_requests
              ELSE session.stop_requests || jsonb_build_array(${ref}::text::jsonb)
            END
          ) WITH ORDINALITY AS request(value, position)
          ORDER BY request.position DESC
          LIMIT ${AGENT_COMPUTER_BACKGROUND_COMMANDS_MAX}
        ) AS kept
      )
      WHERE project_id = ${input.projectId}
        AND owner_principal_type = ${input.ownerPrincipal.type}
        AND owner_principal_id = ${input.ownerPrincipal.id}
        AND id = ${input.id}
      RETURNING *
    `
    return row ? rowToSession(row) : null
  }

  async release(input: {
    readonly projectId: string
    readonly id: string
    readonly ownerPrincipal: Principal
  }): Promise<AgentComputerSessionRecord | null> {
    const [row] = await this.sql<AgentComputerSessionRow[]>`
      DELETE FROM agent_computer_sessions
      WHERE project_id = ${input.projectId}
        AND owner_principal_type = ${input.ownerPrincipal.type}
        AND owner_principal_id = ${input.ownerPrincipal.id}
        AND id = ${input.id}
      RETURNING *
    `
    return row ? rowToSession(row) : null
  }

  async listLive(input: {
    readonly projectId: string
    readonly ownerPrincipal: Principal
    readonly now: Date
  }): Promise<readonly AgentComputerSessionRecord[]> {
    const rows = await this.sql<AgentComputerSessionRow[]>`
      SELECT * FROM agent_computer_sessions
      WHERE project_id = ${input.projectId}
        AND owner_principal_type = ${input.ownerPrincipal.type}
        AND owner_principal_id = ${input.ownerPrincipal.id}
        AND expires_at > ${input.now}
      ORDER BY id
    `
    return rows.map(rowToSession)
  }

  async removeLapsed(input: {
    readonly projectId: string
    readonly now: Date
  }): Promise<readonly AgentComputerSessionRecord[]> {
    const rows = await this.sql<AgentComputerSessionRow[]>`
      DELETE FROM agent_computer_sessions
      WHERE project_id = ${input.projectId} AND expires_at <= ${input.now}
      RETURNING *
    `
    return rows.map(rowToSession)
  }
}

function rowToSession(row: AgentComputerSessionRow): AgentComputerSessionRecord {
  return {
    projectId: row.project_id,
    id: row.id,
    ownerPrincipal: { type: row.owner_principal_type, id: row.owner_principal_id },
    computer: { id: row.computer_id, name: row.computer_name, folder: row.folder },
    expiresAt: new Date(row.expires_at),
    ...(row.background_commands.length > 0 ? { backgroundCommands: row.background_commands } : {}),
    ...(row.stop_requests.length > 0 ? { stopRequests: row.stop_requests } : {}),
  }
}
