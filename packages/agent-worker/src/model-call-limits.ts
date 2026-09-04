import type { AuthorizablePrincipal } from "@sixb/core"
import {
  aiLimitSubjectsFromAttribution,
  aiUsageLimitExceededError,
  aiUsageLimitUnavailableError,
  applicableAiLimitPolicies,
} from "@sixb/core/internal/ai-limit-enforcement"
import { isSixbError } from "@sixb/core/internal/errors"
import type {
  AiLimitPolicy,
  AiLimitQuantity,
  AiModelCallReservationIdentity,
  ReserveAiModelCallResult,
} from "@sixb/core/storage"
import type {
  AiModelCallAdmissionDecision,
  AiModelCallAdmissionInput,
  BeforeAiModelCall,
  MarkAiModelCallUnknown,
} from "./model-call-admission"
import { estimateAiModelCallCost } from "./models-dev/pricing"
import type { AgentWorkerStorage } from "./types"

export interface AiModelCallLimitController {
  readonly beforeModelCall: BeforeAiModelCall
  readonly markModelCallUnknown: MarkAiModelCallUnknown
}

/** Build the shared reservation lifecycle used by conversation and workflow model calls. */
export function createAiModelCallLimitController(input: {
  readonly storage: AgentWorkerStorage
  readonly projectId: string
  readonly requestedBy?: AuthorizablePrincipal
  readonly requesterGroupIds: readonly string[]
}): AiModelCallLimitController {
  const subjects = aiLimitSubjectsFromAttribution(input.requestedBy, input.requesterGroupIds)

  return {
    beforeModelCall: async (admission) => {
      let applicable: readonly AiLimitPolicy[]
      try {
        const policies = await input.storage.aiLimits.listPolicies({
          projectId: input.projectId,
        })
        applicable = applicableAiLimitPolicies(policies, subjects)
      } catch (error) {
        throw limitStorageUnavailable(error)
      }
      // This read is the fast no-policy path. A concurrently created policy linearizes after it;
      // every later call will see it, while existing policies always continue to atomic reserve.
      if (applicable.length === 0) return { reservation: "none" }

      const estimates = reservationEstimates(admission)
      if (estimates.length === 0) {
        throw aiUsageLimitUnavailableError(["missingEstimate"])
      }

      let result: ReserveAiModelCallResult
      try {
        result = await input.storage.aiLimits.reserveModelCall({
          ...reservationIdentity(admission),
          subjects,
          estimates,
        })
      } catch (error) {
        throw limitStorageUnavailable(error)
      }
      switch (result.status) {
        case "reserved":
          return { reservation: "active" } satisfies AiModelCallAdmissionDecision
        case "notRequired":
          return { reservation: "none" } satisfies AiModelCallAdmissionDecision
        case "denied":
          throw aiUsageLimitExceededError(result.resetAt)
        case "unavailable":
          throw aiUsageLimitUnavailableError(result.reasons)
        case "terminal":
          throw aiUsageLimitUnavailableError(["terminalReservationReplay"])
      }
    },
    markModelCallUnknown: async (identity) => {
      try {
        await input.storage.aiLimits.markReservationUnknown(identity)
      } catch (error) {
        throw limitStorageUnavailable(error)
      }
    },
  }
}

function reservationEstimates(input: AiModelCallAdmissionInput): readonly AiLimitQuantity[] {
  if (input.inputTokens.status !== "estimated" || input.estimatedTotalTokens === undefined) {
    return []
  }
  const estimates: AiLimitQuantity[] = [
    { meter: "tokens.total", amount: input.estimatedTotalTokens },
  ]
  const cost = estimateAiModelCallCost({
    providerId: input.providerId,
    modelId: input.modelId,
    pricingContext: input.pricingContext,
    inputTokens: input.inputTokens.tokens,
    outputTokens: input.outputTokenAllowance,
  })
  if (cost.status === "estimated") {
    estimates.push({ meter: "cost.catalogEstimated", amount: cost.money })
  }
  return estimates
}

function reservationIdentity(input: AiModelCallAdmissionInput): AiModelCallReservationIdentity {
  return {
    projectId: input.projectId,
    executionId: input.executionId,
    attempt: input.attempt,
    callId: input.callId,
  }
}

function limitStorageUnavailable(error: unknown): unknown {
  if (
    isSixbError(error) &&
    (error.code === "ai.usage_limit_exceeded" || error.code === "ai.usage_limit_unavailable")
  ) {
    return error
  }
  return aiUsageLimitUnavailableError(["limitStorageUnavailable"])
}
