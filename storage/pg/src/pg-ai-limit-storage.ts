import {
  type AiLimitAccountingEntry,
  aiLimitAmountKey,
  aiLimitQuantityFromAmount,
  aiLimitReservationBuckets,
  aiLimitReservationRequestKey,
  aiLimitReservationRequestMatches,
  aiLimitSubjectFromParts,
  aiLimitSubjectKey,
  aiLimitSubjectParts,
  aiLimitSubjectsFromAccountingEntry,
  assertAiLimitAccountingMatchesReservation,
  assertNonBlank,
  cloneValidDate,
  type NormalizedAiLimitAmount,
  normalizeAiLimitAmount,
  normalizeAiLimitQuantities,
  normalizeAiModelCallReservationIdentity,
  normalizeCreateAiLimitPolicy,
  normalizeReserveAiModelCall,
  normalizeUpdateAiLimitPolicy,
  resolveAiLimitActual,
} from "@sixb/core/internal/ai-limit-storage-provider"
import type {
  AiLimitPeriod,
  AiLimitPolicy,
  AiLimitPolicyStatus,
  AiLimitQuantity,
  AiLimitReservationBucket,
  AiLimitStorage,
  AiLimitSubject,
  AiModelCallReservation,
  CreateAiLimitPolicyInput,
  DeleteAiLimitPolicyInput,
  GetAiLimitPolicyInput,
  ListAiLimitPoliciesInput,
  ListAiLimitPolicyStatusesInput,
  MarkAiModelCallReservationUnknownInput,
  ReconcileAiModelCallInput,
  RecordAiModelCallLimitActualsInput,
  ReserveAiModelCallInput,
  ReserveAiModelCallResult,
  UpdateAiLimitPolicyInput,
} from "@sixb/core/storage"
import { AiLimitStorageError, aiLimitCalendarMonth } from "@sixb/core/storage"
import type { SQLClient } from "./pg-client"
import { lockAdvisoryKeys, type PgStoreClient, runPgTransaction } from "./transactions"

/** PostgreSQL-backed editable AI limits and atomic model-call reservations. */
export class PgAiLimitStorage implements AiLimitStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async createPolicy(input: CreateAiLimitPolicyInput): Promise<AiLimitPolicy> {
    const policy = normalizeCreateAiLimitPolicy(input)
    return this.withProjectLock(policy.projectId, async (tx) => {
      const subject = aiLimitSubjectParts(policy.subject)
      const limit = normalizeAiLimitAmount(policy.limit)
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO ai_usage_limits (
          project_id, id, subject_type, subject_id, meter, currency, limit_amount,
          period_kind, enabled, created_at, updated_at
        ) VALUES (
          ${policy.projectId}, ${policy.id}, ${subject.type}, ${subject.id}, ${limit.meter},
          ${limit.currency}, ${limit.amount.toString()}, ${policy.period}, ${policy.enabled},
          ${policy.createdAt}, ${policy.updatedAt}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `
      if (inserted.length === 0) throw duplicatePolicy(policy)
      return this.requirePolicy(tx, policy.projectId, policy.id)
    })
  }

  async updatePolicy(input: UpdateAiLimitPolicyInput): Promise<AiLimitPolicy> {
    const update = normalizeUpdateAiLimitPolicy(input)
    return this.withProjectLock(update.projectId, async (tx) => {
      const existing = await this.requirePolicy(tx, update.projectId, update.id)
      if (update.limit !== undefined) assertSameDimension(existing.limit, update.limit)
      const limit = normalizeAiLimitAmount(update.limit ?? existing.limit)
      await tx`
        UPDATE ai_usage_limits
        SET limit_amount = ${limit.amount.toString()},
            enabled = ${update.enabled ?? existing.enabled},
            updated_at = ${update.updatedAt}
        WHERE project_id = ${update.projectId} AND id = ${update.id}
      `
      return this.requirePolicy(tx, update.projectId, update.id)
    })
  }

  async deletePolicy(input: DeleteAiLimitPolicyInput): Promise<boolean> {
    validatePolicyIdentity(input)
    return this.withProjectLock(input.projectId, async (tx) => {
      const deleted = await tx<{ id: string }[]>`
        DELETE FROM ai_usage_limits
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING id
      `
      return deleted.length > 0
    })
  }

  async getPolicy(input: GetAiLimitPolicyInput): Promise<AiLimitPolicy | null> {
    validatePolicyIdentity(input)
    const [row] = await this.sql<AiLimitPolicyRow[]>`
      SELECT * FROM ai_usage_limits
      WHERE project_id = ${input.projectId} AND id = ${input.id}
    `
    return row ? policyFromRow(row) : null
  }

  async listPolicies(input: ListAiLimitPoliciesInput): Promise<readonly AiLimitPolicy[]> {
    assertNonBlank(input.projectId, "projectId")
    return (await this.policyRows(this.sql, input.projectId, input.includeDisabled ?? false)).map(
      policyFromRow
    )
  }

  async listPolicyStatuses(
    input: ListAiLimitPolicyStatusesInput
  ): Promise<readonly AiLimitPolicyStatus[]> {
    assertNonBlank(input.projectId, "projectId")
    const period = aiLimitCalendarMonth(input.at ?? new Date())
    const existingGroups =
      input.existingGroupIds === undefined ? undefined : new Set(input.existingGroupIds)
    return this.withProjectLock(input.projectId, async (tx) => {
      const rows = await this.policyRows(tx, input.projectId, input.includeDisabled ?? false)
      return Promise.all(
        rows.map((row) => this.statusForPolicy(tx, policyFromRow(row), period, existingGroups))
      )
    })
  }

  async reserveModelCall(input: ReserveAiModelCallInput): Promise<ReserveAiModelCallResult> {
    const request = normalizeReserveAiModelCall(input)
    return this.withProjectLock(request.identity.projectId, async (tx) => {
      const existing = await this.findReservation(tx, request.identity)
      if (existing) {
        if (!aiLimitReservationRequestMatches(existing, request)) {
          throw new AiLimitStorageError(
            "reservation_conflict",
            `[SixbPg] AI model-call reservation '${input.callId}' was replayed with different subjects, estimates, or period.`
          )
        }
        if (existing.state !== "active") {
          return { status: "terminal", reservation: existing, created: false }
        }
        return { status: "reserved", reservation: existing, created: false }
      }
      await this.assertExecutionExists(tx, request.identity.projectId, request.identity.executionId)

      const subjectKeys = new Set(request.subjects.map(aiLimitSubjectKey))
      const estimates = new Map(
        request.estimates.map((quantity) => {
          const amount = normalizeAiLimitAmount(quantity)
          return [aiLimitAmountKey(amount), amount] as const
        })
      )
      const enabledPolicies = (await this.policyRows(tx, request.identity.projectId, false)).map(
        policyFromRow
      )
      const exhaustedPolicies: AiLimitPolicyStatus[] = []
      const unavailablePolicies: AiLimitPolicyStatus[] = []
      const unavailableReasons = new Set<"missingEstimate" | "incompleteAccounting">()
      for (const policy of enabledPolicies) {
        if (!subjectKeys.has(aiLimitSubjectKey(policy.subject))) continue
        const limit = normalizeAiLimitAmount(policy.limit)
        const estimate = estimates.get(aiLimitAmountKey(limit))
        const status = await this.statusForPolicy(tx, policy, request.period)
        if (!estimate || status.accountingStatus === "unavailable") {
          unavailablePolicies.push(status)
          if (!estimate) unavailableReasons.add("missingEstimate")
          if (status.accountingStatus === "unavailable") {
            unavailableReasons.add("incompleteAccounting")
          }
          continue
        }
        const consumed =
          normalizeAiLimitAmount(status.consumption.actual).amount +
          normalizeAiLimitAmount(status.consumption.reserved).amount +
          normalizeAiLimitAmount(status.consumption.unknown).amount
        if (consumed + estimate.amount > limit.amount) exhaustedPolicies.push(status)
      }
      if (unavailablePolicies.length > 0) {
        unavailablePolicies.sort((left, right) => left.policy.id.localeCompare(right.policy.id))
        return {
          status: "unavailable",
          unavailablePolicies,
          reasons: [...unavailableReasons].sort(),
        }
      }
      if (exhaustedPolicies.length > 0) {
        exhaustedPolicies.sort((left, right) => left.policy.id.localeCompare(right.policy.id))
        return {
          status: "denied",
          exhaustedPolicies,
          resetAt: new Date(
            Math.min(...exhaustedPolicies.map((status) => status.period.resetAt.getTime()))
          ),
        }
      }

      const buckets = aiLimitReservationBuckets(
        enabledPolicies,
        request.subjects,
        request.estimates
      )
      if (buckets.length === 0) return { status: "notRequired" }
      for (const bucket of buckets) {
        const amount = normalizeAiLimitAmount(bucket.estimate)
        await this.changeCounters(
          tx,
          request.identity.projectId,
          bucket.subject,
          amount,
          request.period,
          { reserved: amount.amount },
          request.reservedAt
        )
      }
      const reservation: AiModelCallReservation = {
        ...request.identity,
        buckets,
        requestKey: aiLimitReservationRequestKey(request),
        period: request.period,
        state: "active",
        reservedAt: request.reservedAt,
        updatedAt: new Date(request.reservedAt),
      }
      await this.insertReservation(tx, reservation)
      return { status: "reserved", reservation: structuredClone(reservation), created: true }
    })
  }

  async recordModelCallActuals(input: RecordAiModelCallLimitActualsInput): Promise<void> {
    assertNonBlank(input.projectId, "projectId")
    assertNonBlank(input.usageRecordId, "usageRecordId")
    const recordedAt = cloneValidDate(input.recordedAt ?? new Date(), "recordedAt")
    await this.withProjectLock(input.projectId, async (tx) => {
      const entry = await this.requireAccountingEntry(tx, input.projectId, input.usageRecordId)
      const period = aiLimitCalendarMonth(entry.occurredAt)
      for (const subjectValue of aiLimitSubjectsFromAccountingEntry(entry)) {
        const subject = aiLimitSubjectParts(subjectValue)
        const rows = await tx<AiLimitActualStateRow[]>`
          SELECT meter, currency, actual_amount, accounting_status
          FROM ai_usage_limit_periods
          WHERE project_id = ${input.projectId}
            AND subject_type = ${subject.type}
            AND subject_id = ${subject.id}
            AND period_start = ${period.start}
          FOR UPDATE
        `
        for (const row of rows) {
          const actual = resolveAiLimitActual([entry], row)
          await tx`
            UPDATE ai_usage_limit_periods
            SET actual_amount = ${(BigInt(row.actual_amount) + actual.amount).toString()},
                accounting_status = ${
                  row.accounting_status === "unavailable" ||
                  actual.accountingStatus === "unavailable"
                    ? "unavailable"
                    : "complete"
                },
                updated_at = ${recordedAt}
            WHERE project_id = ${input.projectId}
              AND subject_type = ${subject.type}
              AND subject_id = ${subject.id}
              AND meter = ${row.meter}
              AND currency = ${row.currency}
              AND period_start = ${period.start}
          `
        }
      }
    })
  }

  async reconcileModelCall(input: ReconcileAiModelCallInput): Promise<AiModelCallReservation> {
    const identity = normalizeAiModelCallReservationIdentity(input)
    assertNonBlank(input.usageRecordId, "usageRecordId")
    const reconciledAt = cloneValidDate(input.reconciledAt ?? new Date(), "reconciledAt")
    return this.withProjectLock(identity.projectId, async (tx) => {
      const reservation = await this.findReservation(tx, identity)
      if (!reservation) throw missingReservation(identity)
      if (reservation.state === "reconciled") {
        if (reservation.usageRecordId === input.usageRecordId) {
          return reservation
        }
        throw reconciliationConflict(identity.callId)
      }
      const accounting = await this.requireAccountingEntry(
        tx,
        identity.projectId,
        input.usageRecordId
      )
      assertAiLimitAccountingMatchesReservation(reservation, accounting)
      await this.reconcileEstimateCounters(tx, reservation, accounting, reconciledAt)
      const reconciled: AiModelCallReservation = {
        ...reservation,
        state: "reconciled",
        usageRecordId: input.usageRecordId,
        updatedAt: reconciledAt,
      }
      await this.updateReservation(tx, reconciled)
      return structuredClone(reconciled)
    })
  }

  async markReservationUnknown(
    input: MarkAiModelCallReservationUnknownInput
  ): Promise<AiModelCallReservation> {
    const identity = normalizeAiModelCallReservationIdentity(input)
    const markedAt = cloneValidDate(input.markedAt ?? new Date(), "markedAt")
    return this.withProjectLock(identity.projectId, async (tx) => {
      const reservation = await this.findReservation(tx, identity)
      if (!reservation) throw missingReservation(identity)
      if (reservation.state === "unknown") return reservation
      if (reservation.state !== "active") throw invalidState(reservation, "mark unknown")
      await this.moveEstimateCounters(tx, reservation, { reserved: -1n, unknown: 1n }, markedAt)
      const unknown = { ...reservation, state: "unknown" as const, updatedAt: markedAt }
      await this.updateReservation(tx, unknown)
      return structuredClone(unknown)
    })
  }

  private async withProjectLock<T>(
    projectId: string,
    run: (tx: SQLClient) => Promise<T>
  ): Promise<T> {
    return runPgTransaction(this.sql, async (tx) => {
      await lockAdvisoryKeys(tx, [`ai-limit:${projectId}`])
      return run(tx)
    })
  }

  private policyRows(
    sql: PgStoreClient,
    projectId: string,
    includeDisabled: boolean
  ): Promise<AiLimitPolicyRow[]> {
    return sql<AiLimitPolicyRow[]>`
      SELECT * FROM ai_usage_limits
      WHERE project_id = ${projectId} AND (${includeDisabled} OR enabled)
      ORDER BY id
    `
  }

  private async requirePolicy(
    sql: PgStoreClient,
    projectId: string,
    id: string
  ): Promise<AiLimitPolicy> {
    const [row] = await sql<AiLimitPolicyRow[]>`
      SELECT * FROM ai_usage_limits WHERE project_id = ${projectId} AND id = ${id}
    `
    if (row) return policyFromRow(row)
    throw new AiLimitStorageError(
      "missing_policy",
      `[SixbPg] AI limit policy '${id}' does not exist in project '${projectId}'.`
    )
  }

  private async statusForPolicy(
    sql: PgStoreClient,
    policy: AiLimitPolicy,
    period: AiLimitPeriod,
    existingGroups?: ReadonlySet<string>
  ): Promise<AiLimitPolicyStatus> {
    const subject = aiLimitSubjectParts(policy.subject)
    const limit = normalizeAiLimitAmount(policy.limit)
    let [row] = await sql<AiLimitPeriodStateRow[]>`
      SELECT actual_amount, reserved_amount, unknown_amount, accounting_status
      FROM ai_usage_limit_periods
      WHERE project_id = ${policy.projectId}
        AND subject_type = ${subject.type}
        AND subject_id = ${subject.id}
        AND meter = ${limit.meter}
        AND currency = ${limit.currency}
        AND period_start = ${period.start}
    `
    if (!row) {
      const actual = resolveAiLimitActual(await this.accountingEntries(sql, policy, period), limit)
      const [inserted] = await sql<AiLimitPeriodStateRow[]>`
        INSERT INTO ai_usage_limit_periods (
          project_id, subject_type, subject_id, meter, currency, period_start, period_end,
          actual_amount, reserved_amount, unknown_amount, accounting_status, updated_at
        ) VALUES (
          ${policy.projectId}, ${subject.type}, ${subject.id}, ${limit.meter}, ${limit.currency},
          ${period.start}, ${period.end}, ${actual.amount.toString()}, 0, 0,
          ${actual.accountingStatus}, ${new Date()}
        )
        RETURNING actual_amount, reserved_amount, unknown_amount, accounting_status
      `
      row = inserted
    }
    if (!row) throw new Error("[SixbPg] Failed to initialize AI limit period state.")
    return policyStatus(policy, period, row, existingGroups)
  }

  private async changeCounters(
    sql: PgStoreClient,
    projectId: string,
    subjectValue: AiLimitSubject,
    amount: NormalizedAiLimitAmount,
    period: AiLimitPeriod,
    changes: { readonly reserved?: bigint; readonly unknown?: bigint },
    updatedAt: Date
  ): Promise<void> {
    const subject = aiLimitSubjectParts(subjectValue)
    const [row] = await sql<AiLimitPeriodStateRow[]>`
      SELECT actual_amount, reserved_amount, unknown_amount, accounting_status
      FROM ai_usage_limit_periods
      WHERE project_id = ${projectId}
        AND subject_type = ${subject.type}
        AND subject_id = ${subject.id}
        AND meter = ${amount.meter}
        AND currency = ${amount.currency}
        AND period_start = ${period.start}
      FOR UPDATE
    `
    const reserved = BigInt(row?.reserved_amount ?? "0") + (changes.reserved ?? 0n)
    const unknown = BigInt(row?.unknown_amount ?? "0") + (changes.unknown ?? 0n)
    if (reserved < 0n || unknown < 0n) {
      throw new Error("[SixbPg] AI limit period counter became negative.")
    }
    await sql`
      INSERT INTO ai_usage_limit_periods (
        project_id, subject_type, subject_id, meter, currency, period_start, period_end,
        actual_amount, reserved_amount, unknown_amount, accounting_status, updated_at
      ) VALUES (
        ${projectId}, ${subject.type}, ${subject.id}, ${amount.meter}, ${amount.currency},
        ${period.start}, ${period.end}, ${row?.actual_amount ?? "0"}, ${reserved.toString()},
        ${unknown.toString()}, ${row?.accounting_status ?? "complete"}, ${updatedAt}
      )
      ON CONFLICT (project_id, subject_type, subject_id, meter, currency, period_start)
      DO UPDATE SET
        period_end = excluded.period_end,
        actual_amount = excluded.actual_amount,
        reserved_amount = excluded.reserved_amount,
        unknown_amount = excluded.unknown_amount,
        accounting_status = excluded.accounting_status,
        updated_at = excluded.updated_at
    `
  }

  private async moveEstimateCounters(
    sql: PgStoreClient,
    reservation: AiModelCallReservation,
    directions: { readonly reserved?: bigint; readonly unknown?: bigint },
    updatedAt: Date
  ): Promise<void> {
    for (const bucket of reservation.buckets) {
      const amount = normalizeAiLimitAmount(bucket.estimate)
      await this.changeCounters(
        sql,
        reservation.projectId,
        bucket.subject,
        amount,
        reservation.period,
        {
          ...(directions.reserved === undefined
            ? {}
            : { reserved: directions.reserved * amount.amount }),
          ...(directions.unknown === undefined
            ? {}
            : { unknown: directions.unknown * amount.amount }),
        },
        updatedAt
      )
    }
  }

  private async reconcileEstimateCounters(
    sql: PgStoreClient,
    reservation: AiModelCallReservation,
    entry: AiLimitAccountingEntry,
    updatedAt: Date
  ): Promise<void> {
    for (const bucket of reservation.buckets) {
      const amount = normalizeAiLimitAmount(bucket.estimate)
      const actual = resolveAiLimitActual([entry], amount)
      if (actual.accountingStatus === "complete") {
        await this.changeCounters(
          sql,
          reservation.projectId,
          bucket.subject,
          amount,
          reservation.period,
          reservation.state === "active"
            ? { reserved: -amount.amount }
            : { unknown: -amount.amount },
          updatedAt
        )
      } else if (reservation.state === "active") {
        await this.changeCounters(
          sql,
          reservation.projectId,
          bucket.subject,
          amount,
          reservation.period,
          { reserved: -amount.amount, unknown: amount.amount },
          updatedAt
        )
      }
    }
  }

  private async insertReservation(
    sql: PgStoreClient,
    reservation: AiModelCallReservation
  ): Promise<void> {
    await sql`
      INSERT INTO ai_model_call_reservations (
        project_id, execution_id, attempt, call_id, buckets, request_key,
        period_start, period_end, state, usage_record_id, reserved_at, updated_at
      ) VALUES (
        ${reservation.projectId}, ${reservation.executionId}, ${reservation.attempt},
        ${reservation.callId}, ${JSON.stringify(reservation.buckets)}::text::jsonb,
        ${reservation.requestKey}, ${reservation.period.start},
        ${reservation.period.end}, ${reservation.state}, ${reservation.usageRecordId ?? null},
        ${reservation.reservedAt}, ${reservation.updatedAt}
      )
    `
  }

  private async updateReservation(
    sql: PgStoreClient,
    reservation: AiModelCallReservation
  ): Promise<void> {
    await sql`
      UPDATE ai_model_call_reservations
      SET state = ${reservation.state},
          usage_record_id = ${reservation.usageRecordId ?? null},
          updated_at = ${reservation.updatedAt}
      WHERE project_id = ${reservation.projectId}
        AND execution_id = ${reservation.executionId}
        AND attempt = ${reservation.attempt}
        AND call_id = ${reservation.callId}
    `
  }

  private async findReservation(
    sql: PgStoreClient,
    input: {
      readonly projectId: string
      readonly executionId: string
      readonly attempt: number
      readonly callId: string
    }
  ): Promise<AiModelCallReservation | null> {
    const [row] = await sql<AiModelCallReservationRow[]>`
      SELECT * FROM ai_model_call_reservations
      WHERE project_id = ${input.projectId}
        AND execution_id = ${input.executionId}
        AND attempt = ${input.attempt}
        AND call_id = ${input.callId}
    `
    return row ? reservationFromRow(row) : null
  }

  private async accountingEntries(
    sql: PgStoreClient,
    policy: AiLimitPolicy,
    period: AiLimitPeriod
  ): Promise<readonly AiLimitAccountingEntry[]> {
    const subject = aiLimitSubjectParts(policy.subject)
    const rows = await sql<AiLimitAccountingRow[]>`
      SELECT usage.project_id, usage.id AS usage_record_id, usage.execution_id,
             usage.attempt, usage.call_id, usage.occurred_at,
             usage.total_tokens::text AS total_tokens,
             executions.requested_by_user_id,
             executions.requested_by_service_account_id,
             valuations.status AS valuation_status,
             valuations.currency AS valuation_currency,
             valuations.amount_nanos::text AS valuation_amount_nanos
      FROM ai_model_call_usage AS usage
      JOIN executions
        ON executions.project_id = usage.project_id AND executions.id = usage.execution_id
      LEFT JOIN ai_model_call_valuations AS valuations
        ON valuations.project_id = usage.project_id
       AND valuations.usage_record_id = usage.id
      WHERE usage.project_id = ${policy.projectId}
        AND usage.occurred_at >= ${period.start}
        AND usage.occurred_at < ${period.end}
        AND (
          ${subject.type} = 'project'
          OR (
            ${subject.type} = 'group'
            AND EXISTS (
              SELECT 1 FROM ai_model_call_usage_groups AS usage_groups
              WHERE usage_groups.project_id = usage.project_id
                AND usage_groups.usage_record_id = usage.id
                AND usage_groups.group_id = ${subject.id}
            )
          )
          OR (${subject.type} = 'user' AND executions.requested_by_user_id = ${subject.id})
          OR (
            ${subject.type} = 'serviceAccount'
            AND executions.requested_by_service_account_id = ${subject.id}
          )
        )
      ORDER BY usage.occurred_at, usage.id
    `
    return rows.map((row) => accountingEntryFromRow(row, policy.subject))
  }

  private async requireAccountingEntry(
    sql: PgStoreClient,
    projectId: string,
    usageRecordId: string
  ): Promise<AiLimitAccountingEntry> {
    const [row] = await sql<AiLimitAccountingRow[]>`
      SELECT usage.project_id, usage.id AS usage_record_id, usage.execution_id,
             usage.attempt, usage.call_id, usage.occurred_at,
             usage.total_tokens::text AS total_tokens,
             executions.requested_by_user_id,
             executions.requested_by_service_account_id,
             valuations.status AS valuation_status,
             valuations.currency AS valuation_currency,
             valuations.amount_nanos::text AS valuation_amount_nanos
      FROM ai_model_call_usage AS usage
      JOIN executions
        ON executions.project_id = usage.project_id AND executions.id = usage.execution_id
      LEFT JOIN ai_model_call_valuations AS valuations
        ON valuations.project_id = usage.project_id
       AND valuations.usage_record_id = usage.id
      WHERE usage.project_id = ${projectId} AND usage.id = ${usageRecordId}
    `
    if (row) {
      const groups = await sql<{ group_id: string }[]>`
        SELECT group_id FROM ai_model_call_usage_groups
        WHERE project_id = ${projectId} AND usage_record_id = ${usageRecordId}
        ORDER BY group_id
      `
      return accountingEntryFromRow(
        row,
        undefined,
        groups.map((group) => group.group_id)
      )
    }
    throw new AiLimitStorageError(
      "missing_usage_record",
      `[SixbPg] AI usage record '${usageRecordId}' does not exist in project '${projectId}'.`
    )
  }

  private async assertExecutionExists(
    sql: PgStoreClient,
    projectId: string,
    executionId: string
  ): Promise<void> {
    const [row] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM executions WHERE project_id = ${projectId} AND id = ${executionId}
      ) AS exists
    `
    if (row?.exists) return
    throw new AiLimitStorageError(
      "missing_execution",
      `[SixbPg] AI limit execution '${executionId}' does not exist in project '${projectId}'.`
    )
  }
}

interface AiLimitPolicyRow {
  readonly project_id: string
  readonly id: string
  readonly subject_type: AiLimitSubject["type"]
  readonly subject_id: string
  readonly meter: AiLimitQuantity["meter"]
  readonly currency: string
  readonly limit_amount: string
  readonly period_kind: "calendarMonth"
  readonly enabled: boolean
  readonly created_at: Date | string
  readonly updated_at: Date | string
}

interface AiLimitPeriodStateRow {
  readonly actual_amount: string
  readonly reserved_amount: string
  readonly unknown_amount: string
  readonly accounting_status: "complete" | "unavailable"
}

interface AiLimitActualStateRow {
  readonly meter: AiLimitQuantity["meter"]
  readonly currency: string
  readonly actual_amount: string
  readonly accounting_status: "complete" | "unavailable"
}

interface AiLimitAccountingRow {
  readonly project_id: string
  readonly usage_record_id: string
  readonly execution_id: string
  readonly attempt: number | string
  readonly call_id: string
  readonly occurred_at: Date | string
  readonly total_tokens: string | null
  readonly requested_by_user_id: string | null
  readonly requested_by_service_account_id: string | null
  readonly valuation_status: "rated" | "unpriceable" | null
  readonly valuation_currency: string | null
  readonly valuation_amount_nanos: string | null
}

interface AiModelCallReservationRow {
  readonly project_id: string
  readonly execution_id: string
  readonly attempt: number | string
  readonly call_id: string
  readonly buckets: readonly AiLimitReservationBucket[] | string
  readonly request_key: string
  readonly period_start: Date | string
  readonly period_end: Date | string
  readonly state: AiModelCallReservation["state"]
  readonly usage_record_id: string | null
  readonly reserved_at: Date | string
  readonly updated_at: Date | string
}

function policyFromRow(row: AiLimitPolicyRow): AiLimitPolicy {
  return {
    id: row.id,
    projectId: row.project_id,
    subject: aiLimitSubjectFromParts(row.subject_type, row.subject_id),
    limit: aiLimitQuantityFromAmount({
      meter: row.meter,
      currency: row.currency,
      amount: BigInt(row.limit_amount),
    }),
    period: row.period_kind,
    enabled: row.enabled,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

function policyStatus(
  policy: AiLimitPolicy,
  period: AiLimitPeriod,
  row: AiLimitPeriodStateRow,
  existingGroups?: ReadonlySet<string>
): AiLimitPolicyStatus {
  const limit = normalizeAiLimitAmount(policy.limit)
  const actual = BigInt(row.actual_amount)
  const reserved = BigInt(row.reserved_amount)
  const unknown = BigInt(row.unknown_amount)
  const consumed = actual + reserved + unknown
  const quantity = (amount: bigint) => aiLimitQuantityFromAmount({ ...limit, amount })
  return {
    policy,
    period: structuredClone(period),
    consumption: {
      actual: quantity(actual),
      reserved: quantity(reserved),
      unknown: quantity(unknown),
      remaining: quantity(limit.amount > consumed ? limit.amount - consumed : 0n),
    },
    accountingStatus: row.accounting_status,
    exhausted: consumed >= limit.amount,
    orphaned:
      policy.subject.type === "group" &&
      existingGroups !== undefined &&
      !existingGroups.has(policy.subject.id),
  }
}

function accountingEntryFromRow(
  row: AiLimitAccountingRow,
  subject?: AiLimitSubject,
  requesterGroupIds = subject?.type === "group" ? [subject.id] : []
): AiLimitAccountingEntry {
  const totalTokens = row.total_tokens === null ? undefined : Number(row.total_tokens)
  const requester = row.requested_by_user_id
    ? ({ type: "user", id: row.requested_by_user_id } as const)
    : row.requested_by_service_account_id
      ? ({ type: "serviceAccount", id: row.requested_by_service_account_id } as const)
      : undefined
  return {
    projectId: row.project_id,
    usageRecordId: row.usage_record_id,
    executionId: row.execution_id,
    attempt: Number(row.attempt),
    callId: row.call_id,
    occurredAt: new Date(row.occurred_at),
    ...(totalTokens !== undefined && Number.isSafeInteger(totalTokens) ? { totalTokens } : {}),
    requesterGroupIds,
    ...(requester ? { requester } : {}),
    ...(row.valuation_status === "rated" &&
    row.valuation_currency !== null &&
    row.valuation_amount_nanos !== null
      ? {
          valuation: {
            status: "rated" as const,
            money: {
              currency: row.valuation_currency,
              amountNanos: row.valuation_amount_nanos,
            },
          },
        }
      : row.valuation_status === "unpriceable"
        ? { valuation: { status: "unavailable" as const } }
        : {}),
  }
}

function reservationFromRow(row: AiModelCallReservationRow): AiModelCallReservation {
  const buckets = jsonValue<readonly AiLimitReservationBucket[]>(row.buckets)
  return {
    projectId: row.project_id,
    executionId: row.execution_id,
    attempt: Number(row.attempt),
    callId: row.call_id,
    buckets: buckets.map((bucket) => ({
      subject: structuredClone(bucket.subject),
      estimate: normalizeAiLimitQuantities([bucket.estimate], "stored bucket")[0]!,
    })),
    requestKey: row.request_key,
    period: {
      kind: "calendarMonth",
      start: new Date(row.period_start),
      end: new Date(row.period_end),
      resetAt: new Date(row.period_end),
    },
    state: row.state,
    ...(row.usage_record_id === null ? {} : { usageRecordId: row.usage_record_id }),
    reservedAt: new Date(row.reserved_at),
    updatedAt: new Date(row.updated_at),
  }
}

function jsonValue<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value
}

function assertSameDimension(previous: AiLimitQuantity, next: AiLimitQuantity): void {
  if (
    aiLimitAmountKey(normalizeAiLimitAmount(previous)) !==
    aiLimitAmountKey(normalizeAiLimitAmount(next))
  ) {
    throw new TypeError("[Sixb] AI limit policy meter and cost currency are immutable.")
  }
}

function validatePolicyIdentity(input: GetAiLimitPolicyInput): void {
  assertNonBlank(input.projectId, "projectId")
  assertNonBlank(input.id, "policy id")
}

function duplicatePolicy(policy: AiLimitPolicy): AiLimitStorageError {
  return new AiLimitStorageError(
    "duplicate_policy",
    `[SixbPg] An AI limit policy already exists for policy ID or subject-meter dimension '${policy.id}'.`
  )
}

function missingReservation(input: {
  readonly executionId: string
  readonly attempt: number
  readonly callId: string
}): AiLimitStorageError {
  return new AiLimitStorageError(
    "missing_reservation",
    `[SixbPg] AI model-call reservation '${input.callId}' does not exist for execution '${input.executionId}' attempt ${input.attempt}.`
  )
}

function reconciliationConflict(callId: string): AiLimitStorageError {
  return new AiLimitStorageError(
    "reconciliation_conflict",
    `[SixbPg] AI model-call reservation '${callId}' was reconciled with a different usage record.`
  )
}

function invalidState(reservation: AiModelCallReservation, operation: string): AiLimitStorageError {
  return new AiLimitStorageError(
    "invalid_reservation_state",
    `[SixbPg] Cannot ${operation} AI model-call reservation '${reservation.callId}' in state '${reservation.state}'.`
  )
}
