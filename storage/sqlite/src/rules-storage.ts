import type { Database } from "bun:sqlite"
import type { RuleEventSubject } from "@sixb/core"
import type { StoredRuleResolvedEvent, StoredRuleTriggeredEvent } from "@sixb/core/internal/events"
import type {
  ListActiveRuleStatesInput,
  ListActiveRuleStatesResult,
  ListRuleStatesReconciliationPageInput,
  ListRuleStatesReconciliationPageResult,
  RuleStateRecord,
  RuleStateTransitionEvent,
  RulesStorage,
} from "@sixb/core/storage"
import { installFreshSqliteSchema } from "./migrations"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  runImmediateTransaction,
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

  async getActiveBatch(params: {
    projectId: string
    items: readonly {
      readonly ruleId: string
      readonly subject: RuleEventSubject
    }[]
  }): Promise<readonly RuleStateRecord[]> {
    if (params.items.length === 0) return []
    const rows = this.db
      .query(
        `
          WITH requested AS (
            SELECT
              json_extract(value, '$.ruleId') AS rule_id,
              json_extract(value, '$.subject.kind') AS subject_kind,
              json_extract(value, '$.subject.objectTypeId') AS object_type_id,
              json_extract(value, '$.subject.primaryId') AS primary_id
            FROM json_each(?)
          )
          SELECT states.project_id, states.rule_id, states.subject_kind,
            states.object_type_id, states.primary_id, states.triggered_at
          FROM rule_states AS states
          JOIN requested USING (rule_id, subject_kind, object_type_id, primary_id)
          WHERE states.project_id = ?
        `
      )
      .all(JSON.stringify(params.items), params.projectId) as SqliteRuleStateRow[]
    return rows.map(rowToRuleStateRecord)
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

  async listReconciliationPage(
    input: ListRuleStatesReconciliationPageInput
  ): Promise<ListRuleStatesReconciliationPageResult> {
    assertPositiveLimit(input.limit)
    const rows = this.db
      .query(
        `
          SELECT project_id, rule_id, subject_kind, object_type_id, primary_id, triggered_at
          FROM rule_states
          WHERE project_id = ? AND subject_kind = 'object'
            AND (
              ? IS NULL OR
              (rule_id, object_type_id, primary_id) > (?, ?, ?)
            )
          ORDER BY rule_id ASC, object_type_id ASC, primary_id ASC
          LIMIT ?
        `
      )
      .all(
        input.projectId,
        input.after?.ruleId ?? null,
        input.after?.ruleId ?? null,
        input.after?.objectTypeId ?? null,
        input.after?.primaryId ?? null,
        input.limit + 1
      ) as SqliteRuleStateRow[]
    return reconciliationPage(rows, input.limit)
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

  async applyTransitions(events: readonly RuleStateTransitionEvent[]): Promise<void> {
    if (events.length === 0) return
    const rows = events.map(transitionRow)

    runImmediateTransaction(this.db, () => {
      this.db
        .query(
          `
            WITH transitions AS (
              SELECT
                json_extract(value, '$.type') AS type,
                json_extract(value, '$.projectId') AS project_id,
                json_extract(value, '$.ruleId') AS rule_id,
                json_extract(value, '$.subjectKind') AS subject_kind,
                json_extract(value, '$.objectTypeId') AS object_type_id,
                json_extract(value, '$.primaryId') AS primary_id,
                json_extract(value, '$.transitionAt') AS transition_at
              FROM json_each(?)
            )
            INSERT INTO rule_states (
              project_id, rule_id, subject_kind, object_type_id, primary_id, triggered_at
            )
            SELECT project_id, rule_id, subject_kind, object_type_id, primary_id, transition_at
            FROM transitions
            WHERE type = 'rule.triggered'
            ON CONFLICT(project_id, rule_id, subject_kind, object_type_id, primary_id)
            DO UPDATE SET triggered_at = excluded.triggered_at
          `
        )
        .run(JSON.stringify(rows))

      this.db
        .query(
          `
            WITH transitions AS (
              SELECT
                json_extract(value, '$.type') AS type,
                json_extract(value, '$.projectId') AS project_id,
                json_extract(value, '$.ruleId') AS rule_id,
                json_extract(value, '$.subjectKind') AS subject_kind,
                json_extract(value, '$.objectTypeId') AS object_type_id,
                json_extract(value, '$.primaryId') AS primary_id
              FROM json_each(?)
            )
            DELETE FROM rule_states
            WHERE EXISTS (
              SELECT 1 FROM transitions
              WHERE transitions.type = 'rule.resolved'
                AND transitions.project_id = rule_states.project_id
                AND transitions.rule_id = rule_states.rule_id
                AND transitions.subject_kind = rule_states.subject_kind
                AND transitions.object_type_id = rule_states.object_type_id
                AND transitions.primary_id = rule_states.primary_id
            )
          `
        )
        .run(JSON.stringify(rows))
    })
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }
}

function transitionRow(event: RuleStateTransitionEvent) {
  return {
    type: event.type,
    projectId: event.projectId,
    ruleId: event.payload.ruleId,
    subjectKind: event.payload.subject.kind,
    objectTypeId: event.payload.subject.objectTypeId,
    primaryId: event.payload.subject.primaryId,
    transitionAt:
      event.type === "rule.triggered" ? event.payload.triggeredAt : event.payload.resolvedAt,
  }
}

function reconciliationPage(
  rows: readonly SqliteRuleStateRow[],
  limit: number
): ListRuleStatesReconciliationPageResult {
  const hasMore = rows.length > limit
  const states = rows.slice(0, limit).map(rowToRuleStateRecord)
  const last = states.at(-1)
  return {
    states,
    ...(hasMore && last
      ? {
          next: {
            ruleId: last.ruleId,
            objectTypeId: last.subject.objectTypeId,
            primaryId: last.subject.primaryId,
          },
        }
      : {}),
  }
}

function assertPositiveLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Rules reconciliation page limit must be a positive safe integer.")
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
