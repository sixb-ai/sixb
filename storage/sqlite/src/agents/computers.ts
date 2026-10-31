import type { Database } from "bun:sqlite"
import { assertAgentComputerSession } from "@sixb/core/internal/agent-run-storage-provider"
import type {
  AgentComputerSessionRecord,
  AgentComputerSessionStore,
  Principal,
} from "@sixb/core/storage"

interface AgentComputerSessionRow {
  project_id: string
  owner_principal_type: Principal["type"]
  owner_principal_id: string
  id: string
  computer_id: string
  computer_name: string
  folder: string
  expires_at: string
}

export class SqliteAgentComputerSessionStore implements AgentComputerSessionStore {
  constructor(private readonly db: Database) {}

  async hold(input: AgentComputerSessionRecord): Promise<void> {
    assertAgentComputerSession(input, "SixbSqlite")
    this.db
      .query(
        `INSERT INTO agent_computer_sessions (
           project_id, owner_principal_type, owner_principal_id, id,
           computer_id, computer_name, folder, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, owner_principal_type, owner_principal_id, id)
         DO UPDATE SET
           computer_id = excluded.computer_id,
           computer_name = excluded.computer_name,
           folder = excluded.folder,
           expires_at = excluded.expires_at`
      )
      .run(
        input.projectId,
        input.ownerPrincipal.type,
        input.ownerPrincipal.id,
        input.id,
        input.computer.id,
        input.computer.name,
        input.computer.folder,
        input.expiresAt.toISOString()
      )
  }

  async release(input: {
    readonly projectId: string
    readonly id: string
    readonly ownerPrincipal: Principal
  }): Promise<AgentComputerSessionRecord | null> {
    const row = this.db
      .query(
        `DELETE FROM agent_computer_sessions
         WHERE project_id = ? AND owner_principal_type = ? AND owner_principal_id = ? AND id = ?
         RETURNING *`
      )
      .get(
        input.projectId,
        input.ownerPrincipal.type,
        input.ownerPrincipal.id,
        input.id
      ) as AgentComputerSessionRow | null
    return row && rowToSession(row)
  }

  async listLive(input: {
    readonly projectId: string
    readonly ownerPrincipal: Principal
    readonly now: Date
  }): Promise<readonly AgentComputerSessionRecord[]> {
    const rows = this.db
      .query(
        `SELECT * FROM agent_computer_sessions
         WHERE project_id = ? AND owner_principal_type = ? AND owner_principal_id = ?
           AND expires_at > ?
         ORDER BY id`
      )
      .all(
        input.projectId,
        input.ownerPrincipal.type,
        input.ownerPrincipal.id,
        input.now.toISOString()
      ) as AgentComputerSessionRow[]
    return rows.map(rowToSession)
  }

  async removeLapsed(input: {
    readonly projectId: string
    readonly now: Date
  }): Promise<readonly AgentComputerSessionRecord[]> {
    const rows = this.db
      .query(
        `DELETE FROM agent_computer_sessions WHERE project_id = ? AND expires_at <= ? RETURNING *`
      )
      .all(input.projectId, input.now.toISOString()) as AgentComputerSessionRow[]
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
