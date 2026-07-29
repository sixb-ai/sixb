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
import type { SqlParameter } from "./pg-client"
import type { PgStoreClient } from "./transactions"

export class PgRulesStorage implements RulesStorage {
  constructor(private readonly sql: PgStoreClient) {}

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

  async getActiveBatch(params: {
    projectId: string
    items: readonly {
      readonly ruleId: string
      readonly subject: RuleEventSubject
    }[]
  }): Promise<readonly RuleStateRecord[]> {
    if (params.items.length === 0) return []
    const requested = JSON.stringify(
      params.items.map((item) => ({
        rule_id: item.ruleId,
        subject_kind: item.subject.kind,
        object_type_id: item.subject.objectTypeId,
        primary_id: item.subject.primaryId,
      }))
    )
    const rows = await this.sql<RuleStateRow[]>`
      WITH requested AS (
        SELECT *
        FROM jsonb_to_recordset(${requested}::text::jsonb) AS identity(
          rule_id text,
          subject_kind text,
          object_type_id text,
          primary_id text
        )
      )
        SELECT project_id, rule_id, subject_kind, object_type_id, primary_id, triggered_at
        FROM rule_states AS states
        JOIN requested USING (rule_id, subject_kind, object_type_id, primary_id)
        WHERE states.project_id = ${params.projectId}
    `
    return rows.map(rowToRuleStateRecord)
  }

  async listActive(input: ListActiveRuleStatesInput): Promise<ListActiveRuleStatesResult> {
    if (input.objectTypeIds?.length === 0) {
      return { states: [], hasMore: false, total: 0 }
    }

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

    if (input.objectTypeIds) {
      const placeholders = input.objectTypeIds.map(() => `$${index++}`)
      whereClauses.push(`object_type_id IN (${placeholders.join(", ")})`)
      params.push(...input.objectTypeIds)
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

  async listReconciliationPage(
    input: ListRuleStatesReconciliationPageInput
  ): Promise<ListRuleStatesReconciliationPageResult> {
    assertPositiveLimit(input.limit)
    const params: SqlParameter[] = [input.projectId]
    const cursor = input.after ? "AND (rule_id, object_type_id, primary_id) > ($2, $3, $4)" : ""
    if (input.after) {
      params.push(input.after.ruleId, input.after.objectTypeId, input.after.primaryId)
    }
    params.push(input.limit + 1)
    const limitParameter = `$${params.length}`
    const rows = await this.sql.unsafe<RuleStateRow[]>(
      `
        SELECT project_id, rule_id, subject_kind, object_type_id, primary_id, triggered_at
        FROM rule_states
        WHERE project_id = $1 AND subject_kind = 'object' ${cursor}
        ORDER BY rule_id ASC, object_type_id ASC, primary_id ASC
        LIMIT ${limitParameter}
      `,
      params
    )
    return reconciliationPage(rows, input.limit)
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

  async applyTransitions(events: readonly RuleStateTransitionEvent[]): Promise<void> {
    if (events.length === 0) return
    const rows = JSON.stringify(events.map(transitionRow))
    await this.sql`
      WITH transitions AS MATERIALIZED (
        SELECT *
        FROM jsonb_to_recordset(${rows}::text::jsonb) AS transition(
          type text,
          project_id text,
          rule_id text,
          subject_kind text,
          object_type_id text,
          primary_id text,
          transition_at timestamptz
        )
      ), upserted AS (
        INSERT INTO rule_states (
          project_id, rule_id, subject_kind, object_type_id, primary_id, triggered_at
        )
        SELECT project_id, rule_id, subject_kind, object_type_id, primary_id, transition_at
        FROM transitions
        WHERE type = 'rule.triggered'
        ON CONFLICT (project_id, rule_id, subject_kind, object_type_id, primary_id)
        DO UPDATE SET triggered_at = excluded.triggered_at
        RETURNING 1
      )
      DELETE FROM rule_states AS states
      USING transitions
      WHERE transitions.type = 'rule.resolved'
        AND states.project_id = transitions.project_id
        AND states.rule_id = transitions.rule_id
        AND states.subject_kind = transitions.subject_kind
        AND states.object_type_id = transitions.object_type_id
        AND states.primary_id = transitions.primary_id
    `
  }
}

function transitionRow(event: RuleStateTransitionEvent) {
  return {
    type: event.type,
    project_id: event.projectId,
    rule_id: event.payload.ruleId,
    subject_kind: event.payload.subject.kind,
    object_type_id: event.payload.subject.objectTypeId,
    primary_id: event.payload.subject.primaryId,
    transition_at:
      event.type === "rule.triggered" ? event.payload.triggeredAt : event.payload.resolvedAt,
  }
}

function reconciliationPage(
  rows: readonly RuleStateRow[],
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
