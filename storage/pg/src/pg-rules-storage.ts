import type {
  ListActiveRuleStatesInput,
  ListActiveRuleStatesResult,
  RuleEventSubject,
  RuleStateRecord,
  RulesStorage,
  StoredRuleResolvedEvent,
  StoredRuleTriggeredEvent,
} from "@sixb/core"
import type { SQL, SqlParameter } from "./pg-client"

export class PgRulesStorage implements RulesStorage {
  constructor(private readonly sql: SQL) {}

  async getActive(params: {
    projectId: string
    ruleId: string
    subject: RuleEventSubject
  }): Promise<RuleStateRecord | null> {
    const [row] = await this.sql<RuleStateRow[]>`
      SELECT
        project_id,
        rule_id,
        subject_kind,
        object_type_id,
        primary_id,
        triggered_at
      FROM rule_states
      WHERE project_id = ${params.projectId}
        AND rule_id = ${params.ruleId}
        AND subject_kind = ${params.subject.kind}
        AND object_type_id = ${params.subject.objectTypeId}
        AND primary_id = ${params.subject.primaryId}
    `

    return row ? rowToRuleStateRecord(row) : null
  }

  async listActive(input: ListActiveRuleStatesInput): Promise<ListActiveRuleStatesResult> {
    const whereClauses = ["project_id = $1"]
    const params: SqlParameter[] = [input.projectId]
    let index = 2

    if (input.ruleId) {
      whereClauses.push(`rule_id = $${index++}`)
      params.push(input.ruleId)
    }

    if (input.objectTypeId) {
      whereClauses.push(`object_type_id = $${index++}`)
      params.push(input.objectTypeId)
    }

    if (input.primaryId) {
      whereClauses.push(`primary_id = $${index++}`)
      params.push(input.primaryId)
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "asc" ? "ASC" : "DESC"
    const offset = input.offset ?? 0

    const [totalRow] = await this.sql.unsafe<{ count: string | number }[]>(
      `SELECT COUNT(*)::bigint AS count FROM rule_states ${where}`,
      params
    )

    const queryParams = [...params]
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

    if (input.limit !== undefined) {
      query += ` LIMIT $${index++} OFFSET $${index++}`
      queryParams.push(input.limit, offset)
    } else if (offset > 0) {
      query += ` OFFSET $${index++}`
      queryParams.push(offset)
    }

    const rows = await this.sql.unsafe<RuleStateRow[]>(query, queryParams)
    const total = Number(totalRow?.count ?? 0)
    const states = rows.map(rowToRuleStateRecord)

    return {
      states,
      hasMore: offset + states.length < total,
      total,
    }
  }

  async applyTriggered(event: StoredRuleTriggeredEvent): Promise<void> {
    await this.sql`
      INSERT INTO rule_states (
        project_id,
        rule_id,
        subject_kind,
        object_type_id,
        primary_id,
        triggered_at
      ) VALUES (
        ${event.projectId},
        ${event.payload.ruleId},
        ${event.payload.subject.kind},
        ${event.payload.subject.objectTypeId},
        ${event.payload.subject.primaryId},
        ${event.payload.triggeredAt}
      )
      ON CONFLICT (project_id, rule_id, subject_kind, object_type_id, primary_id)
      DO UPDATE SET triggered_at = excluded.triggered_at
    `
  }

  async applyResolved(event: StoredRuleResolvedEvent): Promise<void> {
    await this.sql`
      DELETE FROM rule_states
      WHERE project_id = ${event.projectId}
        AND rule_id = ${event.payload.ruleId}
        AND subject_kind = ${event.payload.subject.kind}
        AND object_type_id = ${event.payload.subject.objectTypeId}
        AND primary_id = ${event.payload.subject.primaryId}
    `
  }
}

interface RuleStateRow {
  readonly project_id: string
  readonly rule_id: string
  readonly subject_kind: RuleEventSubject["kind"]
  readonly object_type_id: string
  readonly primary_id: string
  readonly triggered_at: Date | string
}

function rowToRuleStateRecord(row: RuleStateRow): RuleStateRecord {
  return {
    projectId: row.project_id,
    ruleId: row.rule_id,
    subject: {
      kind: row.subject_kind,
      objectTypeId: row.object_type_id,
      primaryId: row.primary_id,
    },
    triggeredAt: toIsoString(row.triggered_at),
  }
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
