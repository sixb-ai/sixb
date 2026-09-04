import type { AiModelCallCostRecord } from "../ai-cost"
import type { AiModelCallUsageRecord } from "../ai-usage"
import type { ExecutionRecord } from "../executions"
import { AiLimitStorageError } from "./errors"
import { aiLimitCalendarMonth } from "./period"
import type { AiLimitAccountingEntry } from "./provider"
import {
  aiLimitAccountingEntryAppliesToSubject,
  aiLimitAmountKey,
  aiLimitPolicyDimensionKey,
  aiLimitQuantityFromAmount,
  aiLimitReservationBuckets,
  aiLimitReservationRequestKey,
  aiLimitReservationRequestMatches,
  aiLimitSubjectKey,
  aiLimitSubjectsFromAccountingEntry,
  aiModelCallReservationKey,
  assertAiLimitAccountingMatchesReservation,
  assertNonBlank,
  cloneAiLimitPolicy,
  cloneValidDate,
  type NormalizedAiLimitAmount,
  normalizeAiLimitAmount,
  normalizeAiModelCallReservationIdentity,
  normalizeCreateAiLimitPolicy,
  normalizeReserveAiModelCall,
  normalizeUpdateAiLimitPolicy,
  resolveAiLimitActual,
} from "./provider"
import type {
  AiLimitPeriod,
  AiLimitPolicy,
  AiLimitPolicyStatus,
  AiLimitQuantity,
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
} from "./types"

interface AiLimitPeriodState {
  readonly projectId: string
  readonly subject: AiLimitSubject
  readonly meter: AiLimitQuantity["meter"]
  readonly currency: string
  readonly period: AiLimitPeriod
  actual: bigint
  reserved: bigint
  unknown: bigint
  accountingStatus: "complete" | "unavailable"
  updatedAt: Date
}

export interface InMemoryAiLimitStorageOptions {
  readonly executionExists?: (input: {
    readonly projectId: string
    readonly executionId: string
  }) => boolean | Promise<boolean>
  readonly resolveExecution?: (input: {
    readonly projectId: string
    readonly executionId: string
  }) => ExecutionRecord | null | Promise<ExecutionRecord | null>
  readonly resolveUsageRecord?: (input: {
    readonly projectId: string
    readonly usageRecordId: string
  }) => AiModelCallUsageRecord | null | Promise<AiModelCallUsageRecord | null>
  readonly resolveCostRecord?: (input: {
    readonly projectId: string
    readonly usageRecordId: string
  }) => AiModelCallCostRecord | null | Promise<AiModelCallCostRecord | null>
  readonly listUsageRecords?: (input: {
    readonly projectId: string
  }) => readonly AiModelCallUsageRecord[] | Promise<readonly AiModelCallUsageRecord[]>
}

export interface InMemoryAiLimitStorageSnapshot {
  readonly policies: Map<string, AiLimitPolicy>
  readonly policyIdsByDimension: Map<string, string>
  readonly periodStates: Map<string, AiLimitPeriodState>
  readonly reservations: Map<string, AiModelCallReservation>
}

/** In-memory AI limit provider used by development runtimes and contract tests. */
export class InMemoryAiLimitStorage implements AiLimitStorage {
  private readonly policies = new Map<string, AiLimitPolicy>()
  private readonly policyIdsByDimension = new Map<string, string>()
  private readonly periodStates = new Map<string, AiLimitPeriodState>()
  private readonly reservations = new Map<string, AiModelCallReservation>()

  constructor(private readonly options: InMemoryAiLimitStorageOptions = {}) {}

  async createPolicy(input: CreateAiLimitPolicyInput): Promise<AiLimitPolicy> {
    const policy = normalizeCreateAiLimitPolicy(input)
    const key = policyKey(policy.projectId, policy.id)
    const dimensionKey = aiLimitPolicyDimensionKey(policy)
    if (this.policies.has(key) || this.policyIdsByDimension.has(dimensionKey)) {
      throw new AiLimitStorageError(
        "duplicate_policy",
        `[Sixb] An AI limit policy already exists for '${aiLimitSubjectKey(policy.subject)}' and '${aiLimitAmountKey(normalizeAiLimitAmount(policy.limit))}'.`
      )
    }
    this.policies.set(key, structuredClone(policy))
    this.policyIdsByDimension.set(dimensionKey, key)
    return cloneAiLimitPolicy(policy)
  }

  async updatePolicy(input: UpdateAiLimitPolicyInput): Promise<AiLimitPolicy> {
    const update = normalizeUpdateAiLimitPolicy(input)
    const key = policyKey(update.projectId, update.id)
    const existing = this.policies.get(key)
    if (!existing) throw missingPolicy(update.projectId, update.id)
    if (update.limit !== undefined) {
      const previous = normalizeAiLimitAmount(existing.limit)
      const next = normalizeAiLimitAmount(update.limit)
      if (aiLimitAmountKey(previous) !== aiLimitAmountKey(next)) {
        throw new TypeError("[Sixb] AI limit policy meter and cost currency are immutable.")
      }
    }
    const policy: AiLimitPolicy = {
      ...existing,
      ...(update.limit === undefined ? {} : { limit: update.limit }),
      ...(update.enabled === undefined ? {} : { enabled: update.enabled }),
      updatedAt: update.updatedAt,
    }
    this.policies.set(key, structuredClone(policy))
    return cloneAiLimitPolicy(policy)
  }

  async deletePolicy(input: DeleteAiLimitPolicyInput): Promise<boolean> {
    validatePolicyIdentity(input)
    const key = policyKey(input.projectId, input.id)
    const existing = this.policies.get(key)
    if (!existing) return false
    this.policies.delete(key)
    this.policyIdsByDimension.delete(aiLimitPolicyDimensionKey(existing))
    return true
  }

  async getPolicy(input: GetAiLimitPolicyInput): Promise<AiLimitPolicy | null> {
    validatePolicyIdentity(input)
    const policy = this.policies.get(policyKey(input.projectId, input.id))
    return policy ? cloneAiLimitPolicy(policy) : null
  }

  async listPolicies(input: ListAiLimitPoliciesInput): Promise<readonly AiLimitPolicy[]> {
    assertNonBlank(input.projectId, "projectId")
    return [...this.policies.values()]
      .filter(
        (policy) =>
          policy.projectId === input.projectId && (input.includeDisabled || policy.enabled)
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(cloneAiLimitPolicy)
  }

  async listPolicyStatuses(
    input: ListAiLimitPolicyStatusesInput
  ): Promise<readonly AiLimitPolicyStatus[]> {
    assertNonBlank(input.projectId, "projectId")
    const period = aiLimitCalendarMonth(input.at ?? new Date())
    const existingGroups =
      input.existingGroupIds === undefined ? undefined : new Set(input.existingGroupIds)
    const policies = await this.listPolicies({
      projectId: input.projectId,
      includeDisabled: input.includeDisabled,
    })
    return Promise.all(policies.map((policy) => this.policyStatus(policy, period, existingGroups)))
  }

  async reserveModelCall(input: ReserveAiModelCallInput): Promise<ReserveAiModelCallResult> {
    const request = normalizeReserveAiModelCall(input)
    const reservationKey = aiModelCallReservationKey(request.identity)
    const existing = this.reservations.get(reservationKey)
    if (existing) {
      if (!aiLimitReservationRequestMatches(existing, request)) {
        throw new AiLimitStorageError(
          "reservation_conflict",
          `[Sixb] AI model-call reservation '${input.callId}' was replayed with different subjects, estimates, or period.`
        )
      }
      if (existing.state !== "active") {
        return { status: "terminal", reservation: structuredClone(existing), created: false }
      }
      return { status: "reserved", reservation: structuredClone(existing), created: false }
    }
    await this.assertExecutionExists(request.identity.projectId, request.identity.executionId)

    const enabledPolicies = [...this.policies.values()].filter(
      (policy) => policy.projectId === request.identity.projectId && policy.enabled
    )
    const subjectKeys = new Set(request.subjects.map(aiLimitSubjectKey))
    const estimates = new Map(
      request.estimates.map((quantity) => {
        const amount = normalizeAiLimitAmount(quantity)
        return [aiLimitAmountKey(amount), amount] as const
      })
    )
    const exhaustedPolicies: AiLimitPolicyStatus[] = []
    const unavailablePolicies: AiLimitPolicyStatus[] = []
    const unavailableReasons = new Set<"missingEstimate" | "incompleteAccounting">()
    for (const policy of enabledPolicies) {
      if (!subjectKeys.has(aiLimitSubjectKey(policy.subject))) continue
      const limit = normalizeAiLimitAmount(policy.limit)
      const estimate = estimates.get(aiLimitAmountKey(limit))
      const status = await this.policyStatus(policy, request.period)
      if (!estimate || status.accountingStatus === "unavailable") {
        unavailablePolicies.push(status)
        if (!estimate) unavailableReasons.add("missingEstimate")
        if (status.accountingStatus === "unavailable") {
          unavailableReasons.add("incompleteAccounting")
        }
        continue
      }
      const actual = normalizeAiLimitAmount(status.consumption.actual).amount
      const reserved = normalizeAiLimitAmount(status.consumption.reserved).amount
      const unknown = normalizeAiLimitAmount(status.consumption.unknown).amount
      if (actual + reserved + unknown + estimate.amount > limit.amount) {
        exhaustedPolicies.push(status)
      }
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

    const buckets = aiLimitReservationBuckets(enabledPolicies, request.subjects, request.estimates)
    if (buckets.length === 0) return { status: "notRequired" }
    for (const bucket of buckets) {
      const amount = normalizeAiLimitAmount(bucket.estimate)
      const state = this.requirePeriodState(
        request.identity.projectId,
        bucket.subject,
        amount,
        request.period
      )
      state.reserved += amount.amount
      state.updatedAt = new Date(request.reservedAt)
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
    this.reservations.set(reservationKey, structuredClone(reservation))
    return { status: "reserved", reservation: structuredClone(reservation), created: true }
  }

  async recordModelCallActuals(input: RecordAiModelCallLimitActualsInput): Promise<void> {
    assertNonBlank(input.projectId, "projectId")
    assertNonBlank(input.usageRecordId, "usageRecordId")
    const recordedAt = cloneValidDate(input.recordedAt ?? new Date(), "recordedAt")
    const entry = await this.requireAccountingEntry(input.projectId, input.usageRecordId)
    const period = aiLimitCalendarMonth(entry.occurredAt)
    const subjectKeys = new Set(aiLimitSubjectsFromAccountingEntry(entry).map(aiLimitSubjectKey))
    for (const state of this.periodStates.values()) {
      if (
        state.projectId !== input.projectId ||
        state.period.start.getTime() !== period.start.getTime() ||
        !subjectKeys.has(aiLimitSubjectKey(state.subject))
      ) {
        continue
      }
      const actual = resolveAiLimitActual([entry], state)
      state.actual += actual.amount
      if (actual.accountingStatus === "unavailable") state.accountingStatus = "unavailable"
      state.updatedAt = new Date(recordedAt)
    }
  }

  async reconcileModelCall(input: ReconcileAiModelCallInput): Promise<AiModelCallReservation> {
    const identity = normalizeAiModelCallReservationIdentity(input)
    assertNonBlank(input.usageRecordId, "usageRecordId")
    const reconciledAt = cloneValidDate(input.reconciledAt ?? new Date(), "reconciledAt")
    const key = aiModelCallReservationKey(identity)
    const reservation = this.reservations.get(key)
    if (!reservation) throw missingReservation(identity)
    if (reservation.state === "reconciled") {
      if (reservation.usageRecordId === input.usageRecordId) {
        return structuredClone(reservation)
      }
      throw new AiLimitStorageError(
        "reconciliation_conflict",
        `[Sixb] AI model-call reservation '${identity.callId}' was reconciled with a different usage record.`
      )
    }
    const accounting = await this.requireAccountingEntry(identity.projectId, input.usageRecordId)
    assertAiLimitAccountingMatchesReservation(reservation, accounting)
    this.reconcileEstimateCounters(reservation, accounting, reconciledAt)
    const reconciled: AiModelCallReservation = {
      ...reservation,
      state: "reconciled",
      usageRecordId: input.usageRecordId,
      updatedAt: reconciledAt,
    }
    this.reservations.set(key, structuredClone(reconciled))
    return structuredClone(reconciled)
  }

  async markReservationUnknown(
    input: MarkAiModelCallReservationUnknownInput
  ): Promise<AiModelCallReservation> {
    const identity = normalizeAiModelCallReservationIdentity(input)
    const markedAt = cloneValidDate(input.markedAt ?? new Date(), "markedAt")
    const key = aiModelCallReservationKey(identity)
    const reservation = this.reservations.get(key)
    if (!reservation) throw missingReservation(identity)
    if (reservation.state === "unknown") return structuredClone(reservation)
    if (reservation.state !== "active") throw invalidState(reservation, "mark unknown")
    this.moveEstimateCounter(reservation, "reserved", -1n, markedAt)
    this.moveEstimateCounter(reservation, "unknown", 1n, markedAt)
    const unknown: AiModelCallReservation = {
      ...reservation,
      state: "unknown",
      updatedAt: markedAt,
    }
    this.reservations.set(key, structuredClone(unknown))
    return structuredClone(unknown)
  }

  snapshot(): InMemoryAiLimitStorageSnapshot {
    return structuredClone({
      policies: this.policies,
      policyIdsByDimension: this.policyIdsByDimension,
      periodStates: this.periodStates,
      reservations: this.reservations,
    })
  }

  restore(snapshot: InMemoryAiLimitStorageSnapshot): void {
    replaceMap(this.policies, snapshot.policies)
    replaceMap(this.policyIdsByDimension, snapshot.policyIdsByDimension)
    replaceMap(this.periodStates, snapshot.periodStates)
    replaceMap(this.reservations, snapshot.reservations)
  }

  private async policyStatus(
    policy: AiLimitPolicy,
    period: AiLimitPeriod,
    existingGroups?: ReadonlySet<string>
  ): Promise<AiLimitPolicyStatus> {
    const limit = normalizeAiLimitAmount(policy.limit)
    const state = await this.ensurePeriodState(policy, period)
    const reserved = state.reserved
    const unknown = state.unknown
    const consumed = state.actual + reserved + unknown
    const remaining = limit.amount > consumed ? limit.amount - consumed : 0n
    const quantity = (amount: bigint): AiLimitQuantity =>
      aiLimitQuantityFromAmount({ ...limit, amount })
    return {
      policy: cloneAiLimitPolicy(policy),
      period: structuredClone(period),
      consumption: {
        actual: quantity(state.actual),
        reserved: quantity(reserved),
        unknown: quantity(unknown),
        remaining: quantity(remaining),
      },
      accountingStatus: state.accountingStatus,
      exhausted: consumed >= limit.amount,
      orphaned:
        policy.subject.type === "group" &&
        existingGroups !== undefined &&
        !existingGroups.has(policy.subject.id),
    }
  }

  private async ensurePeriodState(
    policy: AiLimitPolicy,
    period: AiLimitPeriod
  ): Promise<AiLimitPeriodState> {
    const amount = normalizeAiLimitAmount(policy.limit)
    const key = periodStateKey(policy.projectId, policy.subject, amount, period)
    const existing = this.periodStates.get(key)
    if (existing) return existing
    const actual = await this.resolvePolicyActual(policy, period, amount)
    const state: AiLimitPeriodState = {
      projectId: policy.projectId,
      subject: structuredClone(policy.subject),
      meter: amount.meter,
      currency: amount.currency,
      period: structuredClone(period),
      actual: actual.amount,
      reserved: 0n,
      unknown: 0n,
      accountingStatus: actual.accountingStatus,
      updatedAt: new Date(),
    }
    this.periodStates.set(key, state)
    return state
  }

  private moveEstimateCounter(
    reservation: AiModelCallReservation,
    counter: "reserved" | "unknown",
    direction: 1n | -1n,
    updatedAt: Date
  ): void {
    for (const bucket of reservation.buckets) {
      const amount = normalizeAiLimitAmount(bucket.estimate)
      const state = this.requirePeriodState(
        reservation.projectId,
        bucket.subject,
        amount,
        reservation.period
      )
      state[counter] += direction * amount.amount
      if (state[counter] < 0n) {
        throw new Error(`[Sixb] In-memory AI limit ${counter} counter became negative.`)
      }
      state.updatedAt = new Date(updatedAt)
    }
  }

  private reconcileEstimateCounters(
    reservation: AiModelCallReservation,
    entry: AiLimitAccountingEntry,
    updatedAt: Date
  ): void {
    for (const bucket of reservation.buckets) {
      const amount = normalizeAiLimitAmount(bucket.estimate)
      const state = this.requirePeriodState(
        reservation.projectId,
        bucket.subject,
        amount,
        reservation.period
      )
      const counter = reservation.state === "active" ? "reserved" : "unknown"
      const actual = resolveAiLimitActual([entry], amount)
      if (actual.accountingStatus === "complete") {
        state[counter] -= amount.amount
      } else if (reservation.state === "active") {
        state.reserved -= amount.amount
        state.unknown += amount.amount
      }
      if (state.reserved < 0n || state.unknown < 0n) {
        throw new Error("[Sixb] In-memory AI limit reservation counter became negative.")
      }
      state.updatedAt = new Date(updatedAt)
    }
  }

  private requirePeriodState(
    projectId: string,
    subject: AiLimitSubject,
    amount: NormalizedAiLimitAmount,
    period: AiLimitPeriod
  ): AiLimitPeriodState {
    const state = this.periodStates.get(periodStateKey(projectId, subject, amount, period))
    if (!state) throw new Error("[Sixb] In-memory AI limit period state is inconsistent.")
    return state
  }

  private async assertExecutionExists(projectId: string, executionId: string): Promise<void> {
    if (this.options.resolveExecution) {
      if (await this.options.resolveExecution({ projectId, executionId })) return
      throw new AiLimitStorageError(
        "missing_execution",
        `[Sixb] AI limit execution '${executionId}' does not exist in project '${projectId}'.`
      )
    }
    if (
      this.options.executionExists &&
      (await this.options.executionExists({ projectId, executionId }))
    ) {
      return
    }
    throw new AiLimitStorageError(
      "missing_execution",
      `[Sixb] AI limit execution '${executionId}' does not exist in project '${projectId}'.`
    )
  }

  private async resolvePolicyActual(
    policy: AiLimitPolicy,
    period: AiLimitPeriod,
    dimension: NormalizedAiLimitAmount
  ): Promise<ReturnType<typeof resolveAiLimitActual>> {
    if (
      !this.options.listUsageRecords ||
      ((policy.subject.type === "user" || policy.subject.type === "serviceAccount") &&
        !this.options.resolveExecution)
    ) {
      return { amount: 0n, accountingStatus: "unavailable" }
    }
    const records = await this.options.listUsageRecords({ projectId: policy.projectId })
    const entries = await Promise.all(
      records
        .filter(
          (record) =>
            record.occurredAt.getTime() >= period.start.getTime() &&
            record.occurredAt.getTime() < period.end.getTime()
        )
        .map((record) => this.accountingEntry(record))
    )
    return resolveAiLimitActual(
      entries.filter((entry) => aiLimitAccountingEntryAppliesToSubject(entry, policy.subject)),
      dimension
    )
  }

  private async requireAccountingEntry(
    projectId: string,
    usageRecordId: string
  ): Promise<AiLimitAccountingEntry> {
    if (!this.options.resolveUsageRecord) {
      throw new AiLimitStorageError(
        "unavailable_actuals",
        "[Sixb] In-memory AI limit storage has no immutable accounting source."
      )
    }
    const record = await this.options.resolveUsageRecord({ projectId, usageRecordId })
    if (!record) {
      throw new AiLimitStorageError(
        "missing_usage_record",
        `[Sixb] AI usage record '${usageRecordId}' does not exist in project '${projectId}'.`
      )
    }
    return this.accountingEntry(record)
  }

  private async accountingEntry(record: AiModelCallUsageRecord): Promise<AiLimitAccountingEntry> {
    const [execution, cost] = await Promise.all([
      this.options.resolveExecution?.({
        projectId: record.projectId,
        executionId: record.executionId,
      }),
      this.options.resolveCostRecord?.({
        projectId: record.projectId,
        usageRecordId: record.id,
      }),
    ])
    const requester = execution?.requestedBy
    return {
      projectId: record.projectId,
      usageRecordId: record.id,
      executionId: record.executionId,
      attempt: record.attempt,
      callId: record.callId,
      occurredAt: new Date(record.occurredAt),
      ...(record.usage.totalTokens === undefined ? {} : { totalTokens: record.usage.totalTokens }),
      requesterGroupIds: [...record.requesterGroupIds],
      ...(requester?.type === "user" || requester?.type === "serviceAccount"
        ? { requester: { type: requester.type, id: requester.id } }
        : {}),
      ...(cost?.status === "rated"
        ? { valuation: { status: "rated" as const, money: structuredClone(cost.money) } }
        : cost
          ? { valuation: { status: "unavailable" as const } }
          : {}),
    }
  }
}

function policyKey(projectId: string, id: string): string {
  return JSON.stringify([projectId, id])
}

function periodStateKey(
  projectId: string,
  subject: AiLimitSubject,
  amount: Pick<NormalizedAiLimitAmount, "meter" | "currency">,
  period: AiLimitPeriod
): string {
  return JSON.stringify([
    projectId,
    aiLimitSubjectKey(subject),
    amount.meter,
    amount.currency,
    period.start.toISOString(),
  ])
}

function validatePolicyIdentity(input: GetAiLimitPolicyInput): void {
  assertNonBlank(input.projectId, "projectId")
  assertNonBlank(input.id, "policy id")
}

function missingPolicy(projectId: string, id: string): AiLimitStorageError {
  return new AiLimitStorageError(
    "missing_policy",
    `[Sixb] AI limit policy '${id}' does not exist in project '${projectId}'.`
  )
}

function missingReservation(identity: {
  readonly projectId: string
  readonly executionId: string
  readonly attempt: number
  readonly callId: string
}): AiLimitStorageError {
  return new AiLimitStorageError(
    "missing_reservation",
    `[Sixb] AI model-call reservation '${identity.callId}' does not exist for execution '${identity.executionId}' attempt ${identity.attempt}.`
  )
}

function invalidState(reservation: AiModelCallReservation, operation: string): AiLimitStorageError {
  return new AiLimitStorageError(
    "invalid_reservation_state",
    `[Sixb] Cannot ${operation} AI model-call reservation '${reservation.callId}' in state '${reservation.state}'.`
  )
}

function replaceMap<TKey, TValue>(target: Map<TKey, TValue>, source: Map<TKey, TValue>): void {
  target.clear()
  for (const [key, value] of structuredClone(source)) target.set(key, value)
}
