import type { Database } from "bun:sqlite"
import {
  assertAgentBackgroundCommandRef,
  assertAgentComputerSession,
  withStopRequest,
} from "@sixb/core/internal/agent-run-storage-provider"
import type {
  AgentBackgroundCommandRef,
  AgentComputerBackgroundCommand,
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
  background_commands: string
  stop_requests: string
}

export class SqliteAgentComputerSessionStore implements AgentComputerSessionStore {
  constructor(private readonly db: Database) {}

  async hold(input: Omit<AgentComputerSessionRecord, "stopRequests">): Promise<void> {
    assertAgentComputerSession(input, "SixbSqlite")
    this.db
      .query(
        `INSERT INTO agent_computer_sessions (
           project_id, owner_principal_type, owner_principal_id, id,
           computer_id, computer_name, folder, expires_at, background_commands
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, owner_principal_type, owner_principal_id, id)
         DO UPDATE SET
           computer_id = excluded.computer_id,
           computer_name = excluded.computer_name,
           folder = excluded.folder,
           expires_at = excluded.expires_at,
           background_commands = excluded.background_commands`
      )
      .run(
        input.projectId,
        input.ownerPrincipal.type,
        input.ownerPrincipal.id,
        input.id,
        input.computer.id,
        input.computer.name,
        input.computer.folder,
        input.expiresAt.toISOString(),
        JSON.stringify(input.backgroundCommands ?? [])
      )
  }

  async requestStop(input: {
    readonly projectId: string
    readonly id: string
    readonly ownerPrincipal: Principal
    readonly command: AgentBackgroundCommandRef
  }): Promise<AgentComputerSessionRecord | null> {
    assertAgentBackgroundCommandRef(input.command, "SixbSqlite")
    const key = [
      input.projectId,
      input.ownerPrincipal.type,
      input.ownerPrincipal.id,
      input.id,
    ] as const
    // Read and written in one transaction: SQLite runs one writer at a time.
    return this.db.transaction(() => {
      const row = this.db
        .query(
          `SELECT * FROM agent_computer_sessions
           WHERE project_id = ? AND owner_principal_type = ? AND owner_principal_id = ? AND id = ?`
        )
        .get(...key) as AgentComputerSessionRow | null
      if (!row) return null

      const requests = withStopRequest(parseList(row.stop_requests), input.command)
      this.db
        .query(
          `UPDATE agent_computer_sessions SET stop_requests = ?
           WHERE project_id = ? AND owner_principal_type = ? AND owner_principal_id = ? AND id = ?`
        )
        .run(JSON.stringify(requests), ...key)
      return rowToSession({ ...row, stop_requests: JSON.stringify(requests) })
    })()
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
  const background = parseList<AgentComputerBackgroundCommand>(row.background_commands)
  const stopRequests = parseList<AgentBackgroundCommandRef>(row.stop_requests)
  return {
    projectId: row.project_id,
    id: row.id,
    ownerPrincipal: { type: row.owner_principal_type, id: row.owner_principal_id },
    computer: { id: row.computer_id, name: row.computer_name, folder: row.folder },
    expiresAt: new Date(row.expires_at),
    ...(background.length > 0 ? { backgroundCommands: background } : {}),
    ...(stopRequests.length > 0 ? { stopRequests } : {}),
  }
}

function parseList<T>(text: string): T[] {
  const value: unknown = JSON.parse(text)
  return Array.isArray(value) ? (value as T[]) : []
}
