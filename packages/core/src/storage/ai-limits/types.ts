import type { AiMoney } from "../ai-cost"

/** A project-wide, group, or durable requester identity charged for AI model calls. */
export type AiLimitSubject =
  | { readonly type: "project" }
  | { readonly type: "group"; readonly id: string }
  | { readonly type: "user"; readonly id: string }
  | { readonly type: "serviceAccount"; readonly id: string }

/** Aggregate meters supported by the first AI usage-limit release. */
export type AiLimitMeter = "tokens.total" | "cost.catalogEstimated"

/** An exact quantity for one supported meter. */
export type AiLimitQuantity =
  | { readonly meter: "tokens.total"; readonly amount: number }
  | {
      readonly meter: "cost.catalogEstimated"
      readonly amount: AiMoney & { readonly currency: "USD" }
    }

export type AiLimitPeriodKind = "calendarMonth"

/** Inclusive start and exclusive end of one UTC accounting period. */
export interface AiLimitPeriod {
  readonly kind: AiLimitPeriodKind
  readonly start: Date
  readonly end: Date
  /** The first instant at which a denied call may be admitted in the next period. */
  readonly resetAt: Date
}

/** Editable policy. Consumption is intentionally stored independently from this record. */
export interface AiLimitPolicy {
  readonly id: string
  readonly projectId: string
  readonly subject: AiLimitSubject
  readonly limit: AiLimitQuantity
  readonly period: AiLimitPeriodKind
  readonly enabled: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateAiLimitPolicyInput {
  readonly id: string
  readonly projectId: string
  readonly subject: AiLimitSubject
  readonly limit: AiLimitQuantity
  readonly enabled?: boolean
  readonly createdAt?: Date
}

export interface UpdateAiLimitPolicyInput {
  readonly projectId: string
  readonly id: string
  /** The meter and cost currency are immutable; only the amount may change. */
  readonly limit?: AiLimitQuantity
  readonly enabled?: boolean
  readonly updatedAt?: Date
}

export interface GetAiLimitPolicyInput {
  readonly projectId: string
  readonly id: string
}

export interface DeleteAiLimitPolicyInput extends GetAiLimitPolicyInput {}

export interface ListAiLimitPoliciesInput {
  readonly projectId: string
  readonly includeDisabled?: boolean
}

/** Current-period consumption for one policy, all expressed in the policy's meter. */
export interface AiLimitConsumption {
  readonly actual: AiLimitQuantity
  readonly reserved: AiLimitQuantity
  readonly unknown: AiLimitQuantity
  readonly remaining: AiLimitQuantity
}

export interface AiLimitPolicyStatus {
  readonly policy: AiLimitPolicy
  readonly period: AiLimitPeriod
  readonly consumption: AiLimitConsumption
  /** Whether every applicable immutable ledger record could be measured for this policy. */
  readonly accountingStatus: "complete" | "unavailable"
  readonly exhausted: boolean
  /** True only when the caller supplied the current group set and this group is absent. */
  readonly orphaned: boolean
}

export interface ListAiLimitPolicyStatusesInput {
  readonly projectId: string
  readonly at?: Date
  readonly includeDisabled?: boolean
  /** Optional current group IDs used to report policies whose snapshotted group disappeared. */
  readonly existingGroupIds?: readonly string[]
}

export interface AiModelCallReservationIdentity {
  readonly projectId: string
  readonly executionId: string
  readonly attempt: number
  readonly callId: string
}

export interface AiLimitReservationBucket {
  readonly subject: AiLimitSubject
  readonly estimate: AiLimitQuantity
}

export type AiModelCallReservationState = "active" | "reconciled" | "unknown"

/** Durable reservation for one Sixb-owned provider attempt. */
export interface AiModelCallReservation extends AiModelCallReservationIdentity {
  /** Only policy dimensions that were applicable at admission time. */
  readonly buckets: readonly AiLimitReservationBucket[]
  /** Canonical admission request used to reject conflicting idempotent replays. */
  readonly requestKey: string
  readonly period: AiLimitPeriod
  readonly state: AiModelCallReservationState
  readonly usageRecordId?: string
  readonly reservedAt: Date
  readonly updatedAt: Date
}

export interface ReserveAiModelCallInput extends AiModelCallReservationIdentity {
  /** The project subject is always added, even when omitted here. */
  readonly subjects: readonly AiLimitSubject[]
  readonly estimates: readonly AiLimitQuantity[]
  readonly reservedAt?: Date
}

export type ReserveAiModelCallResult =
  | {
      readonly status: "reserved"
      readonly reservation: AiModelCallReservation
      /** False when the exact reservation identity and request were replayed. */
      readonly created: boolean
    }
  | {
      /** No enabled policy matched a supplied subject and estimate. */
      readonly status: "notRequired"
    }
  | {
      /** Exact replay of a reservation that can no longer authorize a provider call. */
      readonly status: "terminal"
      readonly reservation: AiModelCallReservation
      readonly created: false
    }
  | {
      readonly status: "denied"
      /** Every applicable policy that the proposed reservation would exceed. */
      readonly exhaustedPolicies: readonly AiLimitPolicyStatus[]
      readonly resetAt: Date
    }
  | {
      /** Admission failed closed because an applicable policy could not be measured safely. */
      readonly status: "unavailable"
      readonly unavailablePolicies: readonly AiLimitPolicyStatus[]
      readonly reasons: readonly ("missingEstimate" | "incompleteAccounting")[]
    }

export interface ReconcileAiModelCallInput extends AiModelCallReservationIdentity {
  readonly usageRecordId: string
  readonly reconciledAt?: Date
}

export interface MarkAiModelCallReservationUnknownInput extends AiModelCallReservationIdentity {
  readonly markedAt?: Date
}

export interface RecordAiModelCallLimitActualsInput {
  readonly projectId: string
  readonly usageRecordId: string
  readonly recordedAt?: Date
}

export interface AiLimitStorage {
  createPolicy(input: CreateAiLimitPolicyInput): Promise<AiLimitPolicy>
  updatePolicy(input: UpdateAiLimitPolicyInput): Promise<AiLimitPolicy>
  deletePolicy(input: DeleteAiLimitPolicyInput): Promise<boolean>
  getPolicy(input: GetAiLimitPolicyInput): Promise<AiLimitPolicy | null>
  listPolicies(input: ListAiLimitPoliciesInput): Promise<readonly AiLimitPolicy[]>
  listPolicyStatuses(input: ListAiLimitPolicyStatusesInput): Promise<readonly AiLimitPolicyStatus[]>

  reserveModelCall(input: ReserveAiModelCallInput): Promise<ReserveAiModelCallResult>
  /** Applies a newly-created immutable usage record to initialized period counters. */
  recordModelCallActuals(input: RecordAiModelCallLimitActualsInput): Promise<void>
  reconcileModelCall(input: ReconcileAiModelCallInput): Promise<AiModelCallReservation>
  markReservationUnknown(
    input: MarkAiModelCallReservationUnknownInput
  ): Promise<AiModelCallReservation>
}
