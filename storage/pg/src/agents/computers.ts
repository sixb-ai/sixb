import { assertAgentComputerSession } from "@sixb/core/internal/agent-run-storage-provider"
import type {
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
}

export class PgAgentComputerSessionStore implements AgentComputerSessionStore {
  constructor(private readonly sql: PgStoreClient) {}

  async hold(input: AgentComputerSessionRecord): Promise<void> {
    assertAgentComputerSession(input, "SixbPg")
    await this.sql`
      INSERT INTO agent_computer_sessions (
        project_id, owner_principal_type, owner_principal_id, id,
        computer_id, computer_name, folder, expires_at
      ) VALUES (
        ${input.projectId}, ${input.ownerPrincipal.type}, ${input.ownerPrincipal.id}, ${input.id},
        ${input.computer.id}, ${input.computer.name}, ${input.computer.folder}, ${input.expiresAt}
      )
      ON CONFLICT (project_id, owner_principal_type, owner_principal_id, id)
      DO UPDATE SET
        computer_id = excluded.computer_id,
        computer_name = excluded.computer_name,
        folder = excluded.folder,
        expires_at = excluded.expires_at
    `
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
  }
}
