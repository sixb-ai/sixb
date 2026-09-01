import type { SQLQueryBindings } from "bun:sqlite"
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
import { installFreshSqliteSchema } from "./migrations"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  runImmediateTransaction,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteAiLimitStorageOptions {
  readonly path?: string
  readonly connection?: SqliteStoreConnection
}

/** SQLite-backed editable AI limits and atomic model-call reservations. */
export class SqliteAiLimitStorage implements AiLimitStorage {
  private readonly connection: SqliteStoreConnection

  constructor(options: SqliteAiLimitStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    if (this.connection.installFreshSchema) installFreshSqliteSchema(this.connection.db)
  }

  async createPolicy(input: CreateAiLimitPolicyInput): Promise<AiLimitPolicy> {
    const policy = normalizeCreateAiLimitPolicy(input)
    return runImmediateTransaction(this.connection.db, () => {
      const subject = aiLimitSubjectParts(policy.subject)
      const limit = normalizeAiLimitAmount(policy.limit)
      try {
        this.connection.db
          .query(
            `
              INSERT INTO ai_usage_limits (
                project_id, id, subject_type, subject_id, meter, currency, limit_amount,
                period_kind, enabled, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
          )
          .run(
            policy.projectId,
            policy.id,
            subject.type,
            subject.id,
            limit.meter,
            limit.currency,
            limit.amount.toString(),
            policy.period,
            policy.enabled ? 1 : 0,
            policy.createdAt.toISOString(),
            policy.updatedAt.toISOString()
          )
      } catch (error) {
        if (!isConstraintError(error)) throw error
        throw duplicatePolicy(policy)
      }
      return this.requirePolicy(policy.projectId, policy.id)
    })
  }

  async updatePolicy(input: UpdateAiLimitPolicyInput): Promise<AiLimitPolicy> {
    const update = normalizeUpdateAiLimitPolicy(input)
    return runImmediateTransaction(this.connection.db, () => {
      const existing = this.requirePolicy(update.projectId, update.id)
      if (update.limit !== undefined) assertSameDimension(existing.limit, update.limit)
      const limit = normalizeAiLimitAmount(update.limit ?? existing.limit)
      this.connection.db
        .query(
          `
            UPDATE ai_usage_limits
            SET limit_amount = ?, enabled = ?, updated_at = ?
            WHERE project_id = ? AND id = ?
          `
        )
        .run(
          limit.amount.toString(),
          (update.enabled ?? existing.enabled) ? 1 : 0,
          update.updatedAt.toISOString(),
          update.projectId,
          update.id
        )
      return this.requirePolicy(update.projectId, update.id)
    })
  }

  async deletePolicy(input: DeleteAiLimitPolicyInput): Promise<boolean> {
    validatePolicyIdentity(input)
    return runImmediateTransaction(this.connection.db, () => {
      const result = this.connection.db
        .query("DELETE FROM ai_usage_limits WHERE project_id = ? AND id = ?")
        .run(input.projectId, input.id)
      return result.changes > 0
    })
  }

  async getPolicy(input: GetAiLimitPolicyInput): Promise<AiLimitPolicy | null> {
    validatePolicyIdentity(input)
    const row = this.connection.db
      .query("SELECT * FROM ai_usage_limits WHERE project_id = ? AND id = ?")
      .get(input.projectId, input.id) as AiLimitPolicyRow | null
    return row ? policyFromRow(row) : null
  }

  async listPolicies(input: ListAiLimitPoliciesInput): Promise<readonly AiLimitPolicy[]> {
    assertNonBlank(input.projectId, "projectId")
    return this.policyRows(input.projectId, input.includeDisabled ?? false).map(policyFromRow)
  }

  async listPolicyStatuses(
    input: ListAiLimitPolicyStatusesInput
  ): Promise<readonly AiLimitPolicyStatus[]> {
    assertNonBlank(input.projectId, "projectId")
    const period = aiLimitCalendarMonth(input.at ?? new Date())
    const existingGroups =
      input.existingGroupIds === undefined ? undefined : new Set(input.existingGroupIds)
    return runImmediateTransaction(this.connection.db, () =>
      this.policyRows(input.projectId, input.includeDisabled ?? false).map((row) =>
        this.statusForPolicy(policyFromRow(row), period, existingGroups)
      )
    )
  }

  async reserveModelCall(input: ReserveAiModelCallInput): Promise<ReserveAiModelCallResult> {
    const request = normalizeReserveAiModelCall(input)
    return runImmediateTransaction(this.connection.db, () => {
      const existing = this.findReservation(request.identity)
      if (existing) {
        if (!aiLimitReservationRequestMatches(existing, request)) {
          throw new AiLimitStorageError(
            "reservation_conflict",
            `[SixbSqlite] AI model-call reservation '${input.callId}' was replayed with different subjects, estimates, or period.`
          )
        }
        if (existing.state !== "active") {
          return { status: "terminal", reservation: existing, created: false }
        }
        return { status: "reserved", reservation: existing, created: false }
      }
      this.assertExecutionExists(request.identity.projectId, request.identity.executionId)

      const subjectKeys = new Set(request.subjects.map(aiLimitSubjectKey))
      const estimates = new Map(
        request.estimates.map((quantity) => {
          const amount = normalizeAiLimitAmount(quantity)
          return [aiLimitAmountKey(amount), amount] as const
        })
      )
      const enabledPolicies = this.policyRows(request.identity.projectId, false).map(policyFromRow)
      const exhaustedPolicies: AiLimitPolicyStatus[] = []
      const unavailablePolicies: AiLimitPolicyStatus[] = []
      const unavailableReasons = new Set<"missingEstimate" | "incompleteAccounting">()
      for (const policy of enabledPolicies) {
        if (!subjectKeys.has(aiLimitSubjectKey(policy.subject))) continue
        const limit = normalizeAiLimitAmount(policy.limit)
        const estimate = estimates.get(aiLimitAmountKey(limit))
        const status = this.statusForPolicy(policy, request.period)
        if (!estimate || status.accountingStatus === "unavailable") {
          unavailablePolicies.push(status)
          if (!estimate) unavailableReasons.add("missingEstimate")
          if (status.accountingStatus === "unavailable") {
            unavailableReasons.add("incompleteAccounting")
          }
          continue
        }
        const consumption = status.consumption
        const consumed =
          normalizeAiLimitAmount(consumption.actual).amount +
          normalizeAiLimitAmount(consumption.reserved).amount +
          normalizeAiLimitAmount(consumption.unknown).amount
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
        this.changeCounters(
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
      this.insertReservation(reservation)
      return { status: "reserved", reservation: structuredClone(reservation), created: true }
    })
  }

  async recordModelCallActuals(input: RecordAiModelCallLimitActualsInput): Promise<void> {
    assertNonBlank(input.projectId, "projectId")
    assertNonBlank(input.usageRecordId, "usageRecordId")
    const recordedAt = cloneValidDate(input.recordedAt ?? new Date(), "recordedAt")
    runImmediateTransaction(this.connection.db, () => {
      const entry = this.requireAccountingEntry(input.projectId, input.usageRecordId)
      const period = aiLimitCalendarMonth(entry.occurredAt)
      for (const subjectValue of aiLimitSubjectsFromAccountingEntry(entry)) {
        const subject = aiLimitSubjectParts(subjectValue)
        const rows = this.connection.db
          .query(
            `
              SELECT meter, currency, actual_amount, accounting_status
              FROM ai_usage_limit_periods
              WHERE project_id = ? AND subject_type = ? AND subject_id = ?
                AND period_start = ?
            `
          )
          .all(
            input.projectId,
            subject.type,
            subject.id,
            period.start.toISOString()
          ) as AiLimitActualStateRow[]
        for (const row of rows) {
          const actual = resolveAiLimitActual([entry], row)
          this.connection.db
            .query(
              `
                UPDATE ai_usage_limit_periods
                SET actual_amount = ?, accounting_status = ?, updated_at = ?
                WHERE project_id = ? AND subject_type = ? AND subject_id = ?
                  AND meter = ? AND currency = ? AND period_start = ?
              `
            )
            .run(
              (BigInt(row.actual_amount) + actual.amount).toString(),
              row.accounting_status === "unavailable" || actual.accountingStatus === "unavailable"
                ? "unavailable"
                : "complete",
              recordedAt.toISOString(),
              input.projectId,
              subject.type,
              subject.id,
              row.meter,
              row.currency,
              period.start.toISOString()
            )
        }
      }
    })
  }

  async reconcileModelCall(input: ReconcileAiModelCallInput): Promise<AiModelCallReservation> {
    const identity = normalizeAiModelCallReservationIdentity(input)
    assertNonBlank(input.usageRecordId, "usageRecordId")
    const reconciledAt = cloneValidDate(input.reconciledAt ?? new Date(), "reconciledAt")
    return runImmediateTransaction(this.connection.db, () => {
      const reservation = this.findReservation(identity)
      if (!reservation) throw missingReservation(identity)
      if (reservation.state === "reconciled") {
        if (reservation.usageRecordId === input.usageRecordId) {
          return reservation
        }
        throw reconciliationConflict(identity.callId)
      }
      const accounting = this.requireAccountingEntry(identity.projectId, input.usageRecordId)
      assertAiLimitAccountingMatchesReservation(reservation, accounting)
      this.reconcileEstimateCounters(reservation, accounting, reconciledAt)
      const reconciled: AiModelCallReservation = {
        ...reservation,
        state: "reconciled",
        usageRecordId: input.usageRecordId,
        updatedAt: reconciledAt,
      }
      this.updateReservation(reconciled)
      return structuredClone(reconciled)
    })
  }

  async markReservationUnknown(
    input: MarkAiModelCallReservationUnknownInput
  ): Promise<AiModelCallReservation> {
    const identity = normalizeAiModelCallReservationIdentity(input)
    const markedAt = cloneValidDate(input.markedAt ?? new Date(), "markedAt")
    return runImmediateTransaction(this.connection.db, () => {
      const reservation = this.findReservation(identity)
      if (!reservation) throw missingReservation(identity)
      if (reservation.state === "unknown") return reservation
      if (reservation.state !== "active") throw invalidState(reservation, "mark unknown")
      this.moveEstimateCounters(reservation, { reserved: -1n, unknown: 1n }, markedAt)
      const unknown = { ...reservation, state: "unknown" as const, updatedAt: markedAt }
      this.updateReservation(unknown)
      return structuredClone(unknown)
    })
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }

  private policyRows(projectId: string, includeDisabled: boolean): AiLimitPolicyRow[] {
    return this.connection.db
      .query(
        `
          SELECT * FROM ai_usage_limits
          WHERE project_id = ? AND (? = 1 OR enabled = 1)
          ORDER BY id
        `
      )
      .all(projectId, includeDisabled ? 1 : 0) as AiLimitPolicyRow[]
  }

  private requirePolicy(projectId: string, id: string): AiLimitPolicy {
    const row = this.connection.db
      .query("SELECT * FROM ai_usage_limits WHERE project_id = ? AND id = ?")
      .get(projectId, id) as AiLimitPolicyRow | null
    if (row) return policyFromRow(row)
    throw new AiLimitStorageError(
      "missing_policy",
      `[SixbSqlite] AI limit policy '${id}' does not exist in project '${projectId}'.`
    )
  }

  private statusForPolicy(
    policy: AiLimitPolicy,
    period: AiLimitPeriod,
    existingGroups?: ReadonlySet<string>
  ): AiLimitPolicyStatus {
    const subject = aiLimitSubjectParts(policy.subject)
    const limit = normalizeAiLimitAmount(policy.limit)
    let row = this.connection.db
      .query(
        `
          SELECT actual_amount, reserved_amount, unknown_amount, accounting_status
          FROM ai_usage_limit_periods
          WHERE project_id = ? AND subject_type = ? AND subject_id = ?
            AND meter = ? AND currency = ? AND period_start = ?
        `
      )
      .get(
        policy.projectId,
        subject.type,
        subject.id,
        limit.meter,
        limit.currency,
        period.start.toISOString()
      ) as AiLimitPeriodStateRow | null
    if (!row) {
      const actual = resolveAiLimitActual(this.accountingEntries(policy, period), limit)
      row = {
        actual_amount: actual.amount.toString(),
        reserved_amount: "0",
        unknown_amount: "0",
        accounting_status: actual.accountingStatus,
      }
      this.connection.db
        .query(
          `
            INSERT INTO ai_usage_limit_periods (
              project_id, subject_type, subject_id, meter, currency, period_start, period_end,
              actual_amount, reserved_amount, unknown_amount, accounting_status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0', '0', ?, ?)
          `
        )
        .run(
          policy.projectId,
          subject.type,
          subject.id,
          limit.meter,
          limit.currency,
          period.start.toISOString(),
          period.end.toISOString(),
          row.actual_amount,
          row.accounting_status,
          new Date().toISOString()
        )
    }
    return policyStatus(policy, period, row, existingGroups)
  }

  private changeCounters(
    projectId: string,
    subjectValue: AiLimitSubject,
    amount: NormalizedAiLimitAmount,
    period: AiLimitPeriod,
    changes: { readonly reserved?: bigint; readonly unknown?: bigint },
    updatedAt: Date
  ): void {
    const subject = aiLimitSubjectParts(subjectValue)
    const row = this.connection.db
      .query(
        `
          SELECT actual_amount, reserved_amount, unknown_amount, accounting_status
          FROM ai_usage_limit_periods
          WHERE project_id = ? AND subject_type = ? AND subject_id = ?
            AND meter = ? AND currency = ? AND period_start = ?
        `
      )
      .get(
        projectId,
        subject.type,
        subject.id,
        amount.meter,
        amount.currency,
        period.start.toISOString()
      ) as AiLimitPeriodStateRow | null
    const reserved = BigInt(row?.reserved_amount ?? "0") + (changes.reserved ?? 0n)
    const unknown = BigInt(row?.unknown_amount ?? "0") + (changes.unknown ?? 0n)
    if (reserved < 0n || unknown < 0n) {
      throw new Error("[SixbSqlite] AI limit period counter became negative.")
    }
    this.connection.db
      .query(
        `
          INSERT INTO ai_usage_limit_periods (
            project_id, subject_type, subject_id, meter, currency, period_start, period_end,
            actual_amount, reserved_amount, unknown_amount, accounting_status, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (project_id, subject_type, subject_id, meter, currency, period_start)
          DO UPDATE SET
            period_end = excluded.period_end,
            actual_amount = excluded.actual_amount,
            reserved_amount = excluded.reserved_amount,
            unknown_amount = excluded.unknown_amount,
            accounting_status = excluded.accounting_status,
            updated_at = excluded.updated_at
        `
      )
      .run(
        projectId,
        subject.type,
        subject.id,
        amount.meter,
        amount.currency,
        period.start.toISOString(),
        period.end.toISOString(),
        row?.actual_amount ?? "0",
        reserved.toString(),
        unknown.toString(),
        row?.accounting_status ?? "complete",
        updatedAt.toISOString()
      )
  }

  private moveEstimateCounters(
    reservation: AiModelCallReservation,
    directions: { readonly reserved?: bigint; readonly unknown?: bigint },
    updatedAt: Date
  ): void {
    for (const bucket of reservation.buckets) {
      const amount = normalizeAiLimitAmount(bucket.estimate)
      this.changeCounters(
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

  private reconcileEstimateCounters(
    reservation: AiModelCallReservation,
    entry: AiLimitAccountingEntry,
    updatedAt: Date
  ): void {
    for (const bucket of reservation.buckets) {
      const amount = normalizeAiLimitAmount(bucket.estimate)
      const actual = resolveAiLimitActual([entry], amount)
      if (actual.accountingStatus === "complete") {
        this.changeCounters(
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
        this.changeCounters(
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

  private insertReservation(reservation: AiModelCallReservation): void {
    this.connection.db
      .query(
        `
          INSERT INTO ai_model_call_reservations (
            project_id, execution_id, attempt, call_id, buckets, request_key,
            period_start, period_end, state, usage_record_id, reserved_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(...reservationSqlValues(reservation))
  }

  private updateReservation(reservation: AiModelCallReservation): void {
    this.connection.db
      .query(
        `
          UPDATE ai_model_call_reservations
          SET state = ?, usage_record_id = ?, updated_at = ?
          WHERE project_id = ? AND execution_id = ? AND attempt = ? AND call_id = ?
        `
      )
      .run(
        reservation.state,
        reservation.usageRecordId ?? null,
        reservation.updatedAt.toISOString(),
        reservation.projectId,
        reservation.executionId,
        reservation.attempt,
        reservation.callId
      )
  }

  private findReservation(input: {
    readonly projectId: string
    readonly executionId: string
    readonly attempt: number
    readonly callId: string
  }): AiModelCallReservation | null {
    const row = this.connection.db
      .query(
        `
          SELECT * FROM ai_model_call_reservations
          WHERE project_id = ? AND execution_id = ? AND attempt = ? AND call_id = ?
        `
      )
      .get(
        input.projectId,
        input.executionId,
        input.attempt,
        input.callId
      ) as AiModelCallReservationRow | null
    return row ? reservationFromRow(row) : null
  }

  private accountingEntries(
    policy: AiLimitPolicy,
    period: AiLimitPeriod
  ): readonly AiLimitAccountingEntry[] {
    const subject = aiLimitSubjectParts(policy.subject)
    const rows = this.connection.db
      .query(
        `
          SELECT usage.project_id, usage.id AS usage_record_id, usage.execution_id,
                 usage.attempt, usage.call_id, usage.occurred_at,
                 CAST(usage.total_tokens AS TEXT) AS total_tokens,
                 executions.requested_by_user_id,
                 executions.requested_by_service_account_id,
                 valuations.status AS valuation_status,
                 valuations.currency AS valuation_currency,
                 CAST(valuations.amount_nanos AS TEXT) AS valuation_amount_nanos
          FROM ai_model_call_usage AS usage
          JOIN executions
            ON executions.project_id = usage.project_id AND executions.id = usage.execution_id
          LEFT JOIN ai_model_call_valuations AS valuations
            ON valuations.project_id = usage.project_id
           AND valuations.usage_record_id = usage.id
          WHERE usage.project_id = ? AND usage.occurred_at >= ? AND usage.occurred_at < ?
            AND (
              ? = 'project'
              OR (
                ? = 'group'
                AND EXISTS (
                  SELECT 1 FROM ai_model_call_usage_groups AS usage_groups
                  WHERE usage_groups.project_id = usage.project_id
                    AND usage_groups.usage_record_id = usage.id
                    AND usage_groups.group_id = ?
                )
              )
              OR (? = 'user' AND executions.requested_by_user_id = ?)
              OR (
                ? = 'serviceAccount'
                AND executions.requested_by_service_account_id = ?
              )
            )
          ORDER BY usage.occurred_at, usage.id
        `
      )
      .all(
        policy.projectId,
        period.start.toISOString(),
        period.end.toISOString(),
        subject.type,
        subject.type,
        subject.id,
        subject.type,
        subject.id,
        subject.type,
        subject.id
      ) as AiLimitAccountingRow[]
    return rows.map((row) => accountingEntryFromRow(row, policy.subject))
  }

  private requireAccountingEntry(projectId: string, usageRecordId: string): AiLimitAccountingEntry {
    const row = this.connection.db
      .query(
        `
          SELECT usage.project_id, usage.id AS usage_record_id, usage.execution_id,
                 usage.attempt, usage.call_id, usage.occurred_at,
                 CAST(usage.total_tokens AS TEXT) AS total_tokens,
                 executions.requested_by_user_id,
                 executions.requested_by_service_account_id,
                 valuations.status AS valuation_status,
                 valuations.currency AS valuation_currency,
                 CAST(valuations.amount_nanos AS TEXT) AS valuation_amount_nanos
          FROM ai_model_call_usage AS usage
          JOIN executions
            ON executions.project_id = usage.project_id AND executions.id = usage.execution_id
          LEFT JOIN ai_model_call_valuations AS valuations
            ON valuations.project_id = usage.project_id
           AND valuations.usage_record_id = usage.id
          WHERE usage.project_id = ? AND usage.id = ?
        `
      )
      .get(projectId, usageRecordId) as AiLimitAccountingRow | null
    if (row) {
      const groups = this.connection.db
        .query(
          `
            SELECT group_id FROM ai_model_call_usage_groups
            WHERE project_id = ? AND usage_record_id = ?
            ORDER BY group_id
          `
        )
        .all(projectId, usageRecordId) as { readonly group_id: string }[]
      return accountingEntryFromRow(
        row,
        undefined,
        groups.map((group) => group.group_id)
      )
    }
    throw new AiLimitStorageError(
      "missing_usage_record",
      `[SixbSqlite] AI usage record '${usageRecordId}' does not exist in project '${projectId}'.`
    )
  }

  private assertExecutionExists(projectId: string, executionId: string): void {
    const row = this.connection.db
      .query("SELECT 1 FROM executions WHERE project_id = ? AND id = ?")
      .get(projectId, executionId)
    if (row) return
    throw new AiLimitStorageError(
      "missing_execution",
      `[SixbSqlite] AI limit execution '${executionId}' does not exist in project '${projectId}'.`
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
  readonly enabled: number
  readonly created_at: string
  readonly updated_at: string
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
  readonly attempt: number
  readonly call_id: string
  readonly occurred_at: string
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
  readonly attempt: number
  readonly call_id: string
  readonly buckets: string
  readonly request_key: string
  readonly period_start: string
  readonly period_end: string
  readonly state: AiModelCallReservation["state"]
  readonly usage_record_id: string | null
  readonly reserved_at: string
  readonly updated_at: string
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
    enabled: row.enabled === 1,
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
    attempt: row.attempt,
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
  return {
    projectId: row.project_id,
    executionId: row.execution_id,
    attempt: row.attempt,
    callId: row.call_id,
    buckets: normalizeBucketsJson(row.buckets),
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

function normalizeBucketsJson(value: string): readonly AiLimitReservationBucket[] {
  const buckets = JSON.parse(value) as readonly AiLimitReservationBucket[]
  return buckets.map((bucket) => ({
    subject: structuredClone(bucket.subject),
    estimate: normalizeAiLimitQuantities([bucket.estimate], "stored bucket")[0]!,
  }))
}

function reservationSqlValues(reservation: AiModelCallReservation): SQLQueryBindings[] {
  return [
    reservation.projectId,
    reservation.executionId,
    reservation.attempt,
    reservation.callId,
    JSON.stringify(reservation.buckets),
    reservation.requestKey,
    reservation.period.start.toISOString(),
    reservation.period.end.toISOString(),
    reservation.state,
    reservation.usageRecordId ?? null,
    reservation.reservedAt.toISOString(),
    reservation.updatedAt.toISOString(),
  ]
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
    `[SixbSqlite] An AI limit policy already exists for policy ID or subject-meter dimension '${policy.id}'.`
  )
}

function missingReservation(input: {
  readonly executionId: string
  readonly attempt: number
  readonly callId: string
}): AiLimitStorageError {
  return new AiLimitStorageError(
    "missing_reservation",
    `[SixbSqlite] AI model-call reservation '${input.callId}' does not exist for execution '${input.executionId}' attempt ${input.attempt}.`
  )
}

function reconciliationConflict(callId: string): AiLimitStorageError {
  return new AiLimitStorageError(
    "reconciliation_conflict",
    `[SixbSqlite] AI model-call reservation '${callId}' was reconciled with a different usage record.`
  )
}

function invalidState(reservation: AiModelCallReservation, operation: string): AiLimitStorageError {
  return new AiLimitStorageError(
    "invalid_reservation_state",
    `[SixbSqlite] Cannot ${operation} AI model-call reservation '${reservation.callId}' in state '${reservation.state}'.`
  )
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint/i.test(error.message)
}
