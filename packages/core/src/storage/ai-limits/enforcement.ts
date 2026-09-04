import { createSixbError, type SixbCodedError } from "../../errors/internal"
import type { AuthorizablePrincipal } from "../../execution/types"
import type { ReadonlyJsonValue } from "../../json"
import { aiLimitSubjectKey } from "./provider"
import type { AiLimitPolicy, AiLimitPolicyStatus, AiLimitSubject } from "./types"

/** @internal Resolve the immutable attribution dimensions enforced for one model call. */
export function aiLimitSubjectsFromAttribution(
  requestedBy: AuthorizablePrincipal | undefined,
  requesterGroupIds: readonly string[]
): readonly AiLimitSubject[] {
  const subjects: AiLimitSubject[] = [
    { type: "project" },
    ...requesterGroupIds.map((id): AiLimitSubject => ({ type: "group", id })),
  ]
  if (requestedBy) subjects.push(requestedBy)

  const byKey = new Map(subjects.map((subject) => [aiLimitSubjectKey(subject), subject]))
  return [...byKey.values()].sort((left, right) =>
    aiLimitSubjectKey(left).localeCompare(aiLimitSubjectKey(right))
  )
}

/** @internal Select every policy that applies to the call's immutable attribution snapshot. */
export function applicableAiLimitPolicyStatuses(
  statuses: readonly AiLimitPolicyStatus[],
  subjects: readonly AiLimitSubject[]
): readonly AiLimitPolicyStatus[] {
  const keys = new Set(subjects.map(aiLimitSubjectKey))
  return statuses.filter((status) => keys.has(aiLimitSubjectKey(status.policy.subject)))
}

/** @internal Cheap policy-only counterpart used before the authoritative atomic reservation. */
export function applicableAiLimitPolicies(
  policies: readonly AiLimitPolicy[],
  subjects: readonly AiLimitSubject[]
): readonly AiLimitPolicy[] {
  const keys = new Set(subjects.map(aiLimitSubjectKey))
  return policies.filter((policy) => keys.has(aiLimitSubjectKey(policy.subject)))
}

/** @internal Stable failure safe for callers that may only hold run authority. */
export function aiUsageLimitExceededError(resetAt: Date): SixbCodedError {
  return createSixbError(
    "ai.usage_limit_exceeded",
    "[Sixb] An applicable AI usage limit has no capacity for this model call.",
    { details: aiLimitFailureDetails({ resetAt }) }
  )
}

/** @internal Fail closed when an applicable policy cannot be measured or reserved safely. */
export function aiUsageLimitUnavailableError(reasons: readonly string[]): SixbCodedError {
  return createSixbError(
    "ai.usage_limit_unavailable",
    "[Sixb] An applicable AI usage limit could not be evaluated safely.",
    { details: aiLimitFailureDetails({ reasons }) }
  )
}

function aiLimitFailureDetails(input: {
  readonly resetAt?: Date
  readonly reasons?: readonly string[]
}): ReadonlyJsonValue {
  return {
    ...(input.resetAt === undefined ? {} : { resetAt: input.resetAt.toISOString() }),
    ...(input.reasons === undefined ? {} : { reasons: [...input.reasons] }),
  }
}
