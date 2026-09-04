import type { AiMoney } from "../ai-cost"
import { AiLimitStorageError } from "./errors"
import { aiLimitCalendarMonth } from "./period"
import type {
  AiLimitPeriod,
  AiLimitPolicy,
  AiLimitQuantity,
  AiLimitReservationBucket,
  AiLimitSubject,
  AiModelCallReservation,
  AiModelCallReservationIdentity,
  CreateAiLimitPolicyInput,
  ReserveAiModelCallInput,
  UpdateAiLimitPolicyInput,
} from "./types"

const SIGNED_INT64_MAX = 9_223_372_036_854_775_807n

/** @internal Canonical integer quantity used by storage providers. */
export interface NormalizedAiLimitAmount {
  readonly meter: AiLimitQuantity["meter"]
  readonly currency: string
  readonly amount: bigint
}

/** @internal Minimal immutable accounting facts consumed by limit providers. */
export interface AiLimitAccountingEntry {
  readonly projectId: string
  readonly usageRecordId: string
  readonly executionId: string
  readonly attempt: number
  readonly callId: string
  readonly occurredAt: Date
  readonly totalTokens?: number
  readonly requesterGroupIds: readonly string[]
  readonly requester?:
    | { readonly type: "user"; readonly id: string }
    | { readonly type: "serviceAccount"; readonly id: string }
  readonly valuation?:
    | { readonly status: "rated"; readonly money: AiMoney }
    | { readonly status: "unavailable" }
}

export interface ResolvedAiLimitActual {
  readonly amount: bigint
  readonly accountingStatus: "complete" | "unavailable"
}

export function normalizeAiLimitSubject(subject: AiLimitSubject): AiLimitSubject {
  if (!subject || typeof subject !== "object") {
    throw new TypeError("[Sixb] AI limit subject must be an object.")
  }
  if (subject.type === "project") return { type: "project" }
  if (subject.type === "group" || subject.type === "user" || subject.type === "serviceAccount") {
    assertNonBlank(subject.id, "subject id")
    return { type: subject.type, id: subject.id }
  }
  throw new TypeError("[Sixb] AI limit subject type is unsupported.")
}

export function normalizeAiLimitSubjects(
  subjects: readonly AiLimitSubject[]
): readonly AiLimitSubject[] {
  if (!Array.isArray(subjects)) {
    throw new TypeError("[Sixb] AI limit subjects must be an array.")
  }
  const normalized = [
    normalizeAiLimitSubject({ type: "project" }),
    ...subjects.map(normalizeAiLimitSubject),
  ]
  const byKey = new Map(normalized.map((subject) => [aiLimitSubjectKey(subject), subject]))
  return [...byKey.values()].sort((left, right) =>
    aiLimitSubjectKey(left).localeCompare(aiLimitSubjectKey(right))
  )
}

export function aiLimitSubjectKey(subject: AiLimitSubject): string {
  return subject.type === "project" ? "project:" : `${subject.type}:${subject.id}`
}

export function aiLimitSubjectParts(subject: AiLimitSubject): {
  readonly type: AiLimitSubject["type"]
  readonly id: string
} {
  return { type: subject.type, id: subject.type === "project" ? "" : subject.id }
}

export function aiLimitSubjectFromParts(type: AiLimitSubject["type"], id: string): AiLimitSubject {
  return normalizeAiLimitSubject(type === "project" ? { type } : { type, id })
}

export function normalizeAiLimitQuantity(quantity: AiLimitQuantity): AiLimitQuantity {
  const normalized = normalizeAiLimitAmount(quantity)
  return aiLimitQuantityFromAmount(normalized)
}

export function normalizeAiLimitQuantities(
  quantities: readonly AiLimitQuantity[],
  label: string
): readonly AiLimitQuantity[] {
  if (!Array.isArray(quantities) || quantities.length === 0) {
    throw new TypeError(`[Sixb] AI limit ${label} must contain at least one quantity.`)
  }
  const byKey = new Map<string, AiLimitQuantity>()
  for (const quantity of quantities) {
    const normalized = normalizeAiLimitQuantity(quantity)
    const key = aiLimitAmountKey(normalizeAiLimitAmount(normalized))
    if (byKey.has(key)) {
      throw new TypeError(`[Sixb] AI limit ${label} contains duplicate meter '${key}'.`)
    }
    byKey.set(key, normalized)
  }
  return [...byKey.values()].sort((left, right) =>
    aiLimitAmountKey(normalizeAiLimitAmount(left)).localeCompare(
      aiLimitAmountKey(normalizeAiLimitAmount(right))
    )
  )
}

export function normalizeAiLimitAmount(quantity: AiLimitQuantity): NormalizedAiLimitAmount {
  if (!quantity || typeof quantity !== "object") {
    throw new TypeError("[Sixb] AI limit quantity must be an object.")
  }
  if (quantity.meter === "tokens.total") {
    if (!Number.isSafeInteger(quantity.amount) || quantity.amount < 0) {
      throw new TypeError("[Sixb] AI limit token amount must be a non-negative safe integer.")
    }
    return { meter: quantity.meter, currency: "", amount: BigInt(quantity.amount) }
  }
  if (quantity.meter === "cost.catalogEstimated") {
    const money = normalizeAiMoney(quantity.amount)
    return { meter: quantity.meter, currency: money.currency, amount: BigInt(money.amountNanos) }
  }
  throw new TypeError("[Sixb] AI limit meter is unsupported.")
}

export function aiLimitQuantityFromAmount(amount: NormalizedAiLimitAmount): AiLimitQuantity {
  if (amount.amount < 0n) {
    throw new TypeError("[Sixb] AI limit amount cannot be negative.")
  }
  if (amount.meter === "tokens.total") {
    const tokens = Number(amount.amount)
    if (!Number.isSafeInteger(tokens)) {
      throw new RangeError("[Sixb] AI limit token amount exceeds JavaScript's safe integer range.")
    }
    return { meter: amount.meter, amount: tokens }
  }
  if (amount.currency !== "USD") {
    throw new TypeError("[Sixb] AI limit catalog-estimated cost currency must be 'USD'.")
  }
  return {
    meter: amount.meter,
    amount: { currency: "USD", amountNanos: amount.amount.toString() },
  }
}

export function aiLimitAmountKey(
  amount: Pick<NormalizedAiLimitAmount, "meter" | "currency">
): string {
  return `${amount.meter}:${amount.currency}`
}

export function normalizeCreateAiLimitPolicy(input: CreateAiLimitPolicyInput): AiLimitPolicy {
  assertNonBlank(input.id, "policy id")
  assertNonBlank(input.projectId, "projectId")
  const createdAt = cloneValidDate(input.createdAt ?? new Date(), "createdAt")
  return {
    id: input.id,
    projectId: input.projectId,
    subject: normalizeAiLimitSubject(input.subject),
    limit: normalizeAiLimitQuantity(input.limit),
    period: "calendarMonth",
    enabled: input.enabled ?? true,
    createdAt,
    updatedAt: new Date(createdAt),
  }
}

export function normalizeUpdateAiLimitPolicy(input: UpdateAiLimitPolicyInput): {
  readonly projectId: string
  readonly id: string
  readonly limit?: AiLimitQuantity
  readonly enabled?: boolean
  readonly updatedAt: Date
} {
  assertNonBlank(input.projectId, "projectId")
  assertNonBlank(input.id, "policy id")
  if (input.limit === undefined && input.enabled === undefined) {
    throw new TypeError("[Sixb] AI limit policy update must change limit or enabled.")
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new TypeError("[Sixb] AI limit enabled must be a boolean.")
  }
  return {
    projectId: input.projectId,
    id: input.id,
    ...(input.limit === undefined ? {} : { limit: normalizeAiLimitQuantity(input.limit) }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    updatedAt: cloneValidDate(input.updatedAt ?? new Date(), "updatedAt"),
  }
}

export function normalizeReserveAiModelCall(input: ReserveAiModelCallInput): {
  readonly identity: AiModelCallReservationIdentity
  readonly subjects: readonly AiLimitSubject[]
  readonly estimates: readonly AiLimitQuantity[]
  readonly period: AiLimitPeriod
  readonly reservedAt: Date
} {
  const identity = normalizeAiModelCallReservationIdentity(input)
  const reservedAt = cloneValidDate(input.reservedAt ?? new Date(), "reservedAt")
  return {
    identity,
    subjects: normalizeAiLimitSubjects(input.subjects),
    estimates: normalizeAiLimitQuantities(input.estimates, "estimates"),
    period: aiLimitCalendarMonth(reservedAt),
    reservedAt,
  }
}

export function normalizeAiModelCallReservationIdentity(
  input: AiModelCallReservationIdentity
): AiModelCallReservationIdentity {
  assertNonBlank(input.projectId, "projectId")
  assertNonBlank(input.executionId, "executionId")
  if (!Number.isSafeInteger(input.attempt) || input.attempt <= 0) {
    throw new TypeError("[Sixb] AI limit reservation attempt must be a positive safe integer.")
  }
  assertNonBlank(input.callId, "callId")
  return {
    projectId: input.projectId,
    executionId: input.executionId,
    attempt: input.attempt,
    callId: input.callId,
  }
}

export function aiModelCallReservationKey(identity: AiModelCallReservationIdentity): string {
  return JSON.stringify([
    identity.projectId,
    identity.executionId,
    identity.attempt,
    identity.callId,
  ])
}

export function aiLimitPolicyDimensionKey(
  policy: Pick<AiLimitPolicy, "projectId" | "subject" | "limit">
): string {
  const amount = normalizeAiLimitAmount(policy.limit)
  return JSON.stringify([
    policy.projectId,
    aiLimitSubjectKey(policy.subject),
    amount.meter,
    amount.currency,
  ])
}

export function aiLimitReservationRequestMatches(
  reservation: AiModelCallReservation,
  request: ReturnType<typeof normalizeReserveAiModelCall>
): boolean {
  return reservation.requestKey === aiLimitReservationRequestKey(request)
}

export function aiLimitReservationRequestKey(
  request: ReturnType<typeof normalizeReserveAiModelCall>
): string {
  return JSON.stringify([
    request.period.start.toISOString(),
    request.subjects.map(aiLimitSubjectKey),
    request.estimates.map((quantity) => {
      const amount = normalizeAiLimitAmount(quantity)
      return [amount.meter, amount.currency, amount.amount.toString()]
    }),
  ])
}

export function aiLimitReservationBuckets(
  policies: readonly AiLimitPolicy[],
  subjects: readonly AiLimitSubject[],
  estimates: readonly AiLimitQuantity[]
): readonly AiLimitReservationBucket[] {
  const subjectKeys = new Set(subjects.map(aiLimitSubjectKey))
  const estimatesByDimension = new Map(
    estimates.map((estimate) => {
      const amount = normalizeAiLimitAmount(estimate)
      return [aiLimitAmountKey(amount), estimate] as const
    })
  )
  return policies
    .filter((policy) => subjectKeys.has(aiLimitSubjectKey(policy.subject)))
    .flatMap((policy) => {
      const estimate = estimatesByDimension.get(
        aiLimitAmountKey(normalizeAiLimitAmount(policy.limit))
      )
      return estimate ? [{ subject: policy.subject, estimate }] : []
    })
    .sort((left, right) => {
      const subject = aiLimitSubjectKey(left.subject).localeCompare(
        aiLimitSubjectKey(right.subject)
      )
      if (subject !== 0) return subject
      return aiLimitAmountKey(normalizeAiLimitAmount(left.estimate)).localeCompare(
        aiLimitAmountKey(normalizeAiLimitAmount(right.estimate))
      )
    })
}

export function aiLimitAccountingEntryAppliesToSubject(
  entry: AiLimitAccountingEntry,
  subject: AiLimitSubject
): boolean {
  if (subject.type === "project") return true
  if (subject.type === "group") return entry.requesterGroupIds.includes(subject.id)
  return entry.requester?.type === subject.type && entry.requester.id === subject.id
}

export function aiLimitSubjectsFromAccountingEntry(
  entry: AiLimitAccountingEntry
): readonly AiLimitSubject[] {
  return normalizeAiLimitSubjects([
    ...entry.requesterGroupIds.map((id) => ({ type: "group" as const, id })),
    ...(entry.requester ? [entry.requester] : []),
  ])
}

export function resolveAiLimitActual(
  entries: readonly AiLimitAccountingEntry[],
  dimension: Pick<NormalizedAiLimitAmount, "meter" | "currency">
): ResolvedAiLimitActual {
  let amount = 0n
  let accountingStatus: ResolvedAiLimitActual["accountingStatus"] = "complete"
  for (const entry of entries) {
    if (dimension.meter === "tokens.total") {
      if (entry.totalTokens === undefined) {
        accountingStatus = "unavailable"
      } else {
        amount += BigInt(entry.totalTokens)
      }
      continue
    }
    if (
      entry.valuation?.status !== "rated" ||
      entry.valuation.money.currency !== dimension.currency
    ) {
      accountingStatus = "unavailable"
      continue
    }
    amount += BigInt(entry.valuation.money.amountNanos)
  }
  return { amount, accountingStatus }
}

export function assertAiLimitAccountingMatchesReservation(
  reservation: AiModelCallReservation,
  entry: AiLimitAccountingEntry
): void {
  if (
    entry.projectId !== reservation.projectId ||
    entry.executionId !== reservation.executionId ||
    entry.attempt !== reservation.attempt ||
    entry.callId !== reservation.callId
  ) {
    throw new AiLimitStorageError(
      "usage_mismatch",
      `[Sixb] AI usage record '${entry.usageRecordId}' does not belong to reservation '${reservation.callId}'.`
    )
  }
}

export function cloneAiLimitPolicy(policy: AiLimitPolicy): AiLimitPolicy {
  return structuredClone(policy)
}

function normalizeAiMoney(money: AiMoney): AiMoney & { readonly currency: "USD" } {
  if (!money || typeof money !== "object") {
    throw new TypeError("[Sixb] AI limit cost amount must be AiMoney.")
  }
  assertNonBlank(money.currency, "cost currency")
  if (money.currency !== "USD") {
    throw new TypeError("[Sixb] AI limit catalog-estimated cost currency must be 'USD'.")
  }
  if (!/^(0|[1-9][0-9]*)$/.test(money.amountNanos)) {
    throw new TypeError(
      "[Sixb] AI limit cost amountNanos must be a canonical non-negative integer string."
    )
  }
  if (BigInt(money.amountNanos) > SIGNED_INT64_MAX) {
    throw new RangeError("[Sixb] AI limit cost amountNanos exceeds the supported range.")
  }
  return { currency: "USD", amountNanos: money.amountNanos }
}

export function assertNonBlank(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`[Sixb] AI limit ${label} must be nonblank.`)
  }
}

export function cloneValidDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`[Sixb] AI limit ${label} must be a valid Date.`)
  }
  return new Date(value)
}
