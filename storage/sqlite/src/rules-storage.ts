import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type {
  ListActiveRuleStatesInput,
  ListActiveRuleStatesResult,
  RuleEventSubject,
  RuleStateRecord,
  RulesStorage,
  StoredRuleResolvedEvent,
  StoredRuleTriggeredEvent,
} from "@pario/core"
import { installFreshSqliteSchema } from "./migrations"

export interface SqliteRulesStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
}

export class SqliteRulesStorage implements RulesStorage {
  private readonly db: Database

  constructor(options: SqliteRulesStorageOptions = {}) {
    const path = options.path ?? ":memory:"
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)

    if (path === ":memory:") {
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
    this.db.close()
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
