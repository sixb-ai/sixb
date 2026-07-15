import type { Database } from "bun:sqlite"
import type { RuleEventSubject } from "@sixb/core"
import type { StoredRuleResolvedEvent, StoredRuleTriggeredEvent } from "@sixb/core/internal/events"
import type {
  ListActiveRuleStatesInput,
  ListActiveRuleStatesResult,
  RuleStateRecord,
  RulesStorage,
} from "@sixb/core/storage"
import { installFreshSqliteSchema } from "./migrations"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteRulesStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
}

export class SqliteRulesStorage implements RulesStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  constructor(options: SqliteRulesStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.db)
    }
  }

  async getActive(params: {
    projectId: string
    ruleId: string
    subject: RuleEventSubject
  }): Promise<RuleStateRecord | null> {
    const row = this.db
      .query(
        `
        SELECT
          project_id,
          rule_id,
          subject_kind,
          object_type_id,
          primary_id,
          triggered_at
        FROM rule_states
        WHERE project_id = ?
          AND rule_id = ?
          AND subject_kind = ?
          AND object_type_id = ?
          AND primary_id = ?
      `
      )
      .get(
        params.projectId,
        params.ruleId,
        params.subject.kind,
        params.subject.objectTypeId,
        params.subject.primaryId
      ) as SqliteRuleStateRow | null

    return row ? rowToRuleStateRecord(row) : null
  }

  async listActive(input: ListActiveRuleStatesInput): Promise<ListActiveRuleStatesResult> {
    if (input.objectTypeIds?.length === 0) {
      return { states: [], hasMore: false, total: 0 }
    }

    const whereClauses = ["project_id = ?"]
    const args: (string | number)[] = [input.projectId]

    if (input.ruleId) {
      whereClauses.push("rule_id = ?")
      args.push(input.ruleId)
    }

    if (input.objectTypeId) {
      whereClauses.push("object_type_id = ?")
      args.push(input.objectTypeId)
    }

    if (input.objectTypeIds) {
      whereClauses.push(`object_type_id IN (${input.objectTypeIds.map(() => "?").join(", ")})`)
      args.push(...input.objectTypeIds)
    }

    if (input.primaryId) {
      whereClauses.push("primary_id = ?")
      args.push(input.primaryId)
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "asc" ? "ASC" : "DESC"
    const offset = input.offset ?? 0
    const limit = input.limit
    const totalRow = this.db
      .query(`SELECT COUNT(*) AS count FROM rule_states ${where}`)
      .get(...args) as { count: number }

    let query = `
      SELECT
        project_id,
        rule_id,
        subject_kind,
        object_type_id,
        primary_id,
        triggered_at
      FROM rule_states
      ${where}
      ORDER BY triggered_at ${order}, rule_id ${order}, object_type_id ${order}, primary_id ${order}
    `
    const queryArgs = [...args]

    if (limit !== undefined) {
      query += " LIMIT ? OFFSET ?"
      queryArgs.push(limit, offset)
    } else if (offset > 0) {
      query += " LIMIT -1 OFFSET ?"
      queryArgs.push(offset)
    }

    const rows = this.db.query(query).all(...queryArgs) as SqliteRuleStateRow[]
    const states = rows.map(rowToRuleStateRecord)

    return {
      states,
      hasMore: offset + states.length < totalRow.count,
      total: totalRow.count,
    }
  }

  async applyTriggered(event: StoredRuleTriggeredEvent): Promise<void> {
    this.db
      .query(
        `
        INSERT INTO rule_states (
          project_id,
          rule_id,
          subject_kind,
          object_type_id,
          primary_id,
          triggered_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, rule_id, subject_kind, object_type_id, primary_id)
        DO UPDATE SET triggered_at = excluded.triggered_at
      `
      )
      .run(
        event.projectId,
        event.payload.ruleId,
        event.payload.subject.kind,
        event.payload.subject.objectTypeId,
        event.payload.subject.primaryId,
        event.payload.triggeredAt
      )
  }

  async applyResolved(event: StoredRuleResolvedEvent): Promise<void> {
    this.db
      .query(
        `
        DELETE FROM rule_states
        WHERE project_id = ?
          AND rule_id = ?
          AND subject_kind = ?
          AND object_type_id = ?
          AND primary_id = ?
      `
      )
      .run(
        event.projectId,
        event.payload.ruleId,
        event.payload.subject.kind,
        event.payload.subject.objectTypeId,
        event.payload.subject.primaryId
      )
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }
}

interface SqliteRuleStateRow {
  readonly project_id: string
  readonly rule_id: string
  readonly subject_kind: RuleEventSubject["kind"]
  readonly object_type_id: string
  readonly primary_id: string
  readonly triggered_at: string
}

function rowToRuleStateRecord(row: SqliteRuleStateRow): RuleStateRecord {
  return {
    projectId: row.project_id,
    ruleId: row.rule_id,
    subject: {
      kind: row.subject_kind,
      objectTypeId: row.object_type_id,
      primaryId: row.primary_id,
    },
    triggeredAt: row.triggered_at,
  }
}
