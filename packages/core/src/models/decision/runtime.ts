import { randomUUID } from "node:crypto"
import { assertProviderAccess } from "../../authorization"
import type { ExecutionContext } from "../../execution"
import { cloneJsonValue } from "../../json"
import type { SixbRuntimeContext } from "../../runtime/types"
import type { ModelCatalog } from "../catalog"
import { AI_MODEL_CALL_OUTPUT_TOKEN_ALLOWANCE } from "../execution/model-call-admission"
import type { AiModelCallRecorder } from "../execution/model-call-recorder"
import type { ModelExecutionSession } from "../execution/session"
import { estimateModelCall } from "../pricing"
import { DecisionModelResponseError } from "./errors"
import type {
  DecisionAnswers,
  DecisionModel,
  DecisionModelRequest,
  DecisionModelResponseMetadata,
  DecisionModelResult,
  DecisionModelsRuntime,
} from "./types"
import {
  assertDecisionContent,
  assertDecisionModel,
  assertDecisionQuestions,
  assertDecisionSupport,
  validateDecisionAnswers,
} from "./validation"

export function createDecisionRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  catalog: ModelCatalog | undefined,
  session: ModelExecutionSession
): DecisionModelsRuntime {
  return {
    async evaluate(input) {
      assertProviderAccess(runtime, execution, "models.decision.evaluate")
      assertDecisionContent(input.input, "input")
      assertDecisionQuestions(input.questions)

      // Snapshot before the first await; caller edits cannot change an admitted request.
      const state = cloneJsonValue(input.input)
      assertDecisionContent(state, "input")
      const questions = structuredClone(input.questions)
      const signal = session.signal(input.signal)
      signal.throwIfAborted()

      const binding = resolveDecisionModel(catalog, input.model)
      assertDecisionModel(binding)
      assertDecisionSupport(binding, questions)

      const accounting = await session.accounting()
      accounting.assertHealthy()
      signal.throwIfAborted()
      const model = binding.resolve ? await binding.resolve() : binding
      assertDecisionModel(model)
      if (model.providerId !== binding.providerId || model.modelId !== binding.modelId) {
        throw new TypeError(
          "[SixbModels] Resolved decision model identity does not match the selected model."
        )
      }
      assertDecisionSupport(model, questions)
      signal.throwIfAborted()
      const request = { input: state, questions, signal }
      const callId = await admitDecisionCall(accounting, model, request)

      let result: DecisionModelResult
      try {
        signal.throwIfAborted()
        result = await model.evaluate(request)
      } catch (error) {
        const metadata = error instanceof DecisionModelResponseError ? error.metadata : {}
        await recordDecision(accounting, model, callId, metadata)
        throw error
      }

      // Account before validation or cancellation can reject a billable response.
      const event = await recordDecision(accounting, model, callId, result ?? {})
      signal.throwIfAborted()

      let output: DecisionAnswers<typeof input.questions>
      try {
        output = validateDecisionAnswers(
          questions,
          result?.output,
          model.definition.capabilities.answerDecimalPlaces
        )
      } catch (cause) {
        throw new DecisionModelResponseError(
          "[SixbModels] Invalid decision response.",
          model.providerId,
          model.modelId,
          result ?? {},
          { cause }
        )
      }

      return {
        output,
        callId,
        ...(event.responseModelId === undefined ? {} : { responseModelId: event.responseModelId }),
        usage: event.usage,
        cost: event.cost,
      }
    },
  }
}

function resolveDecisionModel(
  catalog: ModelCatalog | undefined,
  requested: DecisionModel | undefined
): DecisionModel {
  if (!requested) {
    const model = catalog?.decision?.default.model
    if (!model) {
      throw new Error("[SixbModels] Configure models.decision or supply a model to evaluate().")
    }
    return model
  }

  if (!catalog) return requested

  // The catalog owns the binding, even when a caller supplies another object with the same ID.
  const entry = catalog.decision?.getByRef({
    provider: requested.providerId,
    modelId: requested.modelId,
  })
  if (!entry) {
    throw new Error(
      `[SixbModels] Model '${requested.providerId}/${requested.modelId}' is not configured in models.decision.`
    )
  }
  return entry.model
}

async function admitDecisionCall(
  accounting: AiModelCallRecorder,
  model: DecisionModel,
  request: DecisionModelRequest
): Promise<string> {
  const callId = `call_${randomUUID()}`
  const serialized = JSON.stringify({ input: request.input, questions: request.questions })
  const tokens = Math.ceil(new TextEncoder().encode(serialized).byteLength / 4)

  // Reservation estimate only; neither an exact context check nor an enforced output cap.
  const outputTokenAllowance = AI_MODEL_CALL_OUTPUT_TOKEN_ALLOWANCE
  await accounting.admitCall({
    callId,
    providerId: model.providerId,
    modelId: model.modelId,
    costEstimator: model.costEstimator,
    inputTokens: { status: "estimated", tokens, method: "utf8BytesDividedByFour" },
    outputTokenAllowance,
    estimatedTotalTokens: tokens + outputTokenAllowance,
  })

  return callId
}

async function recordDecision(
  accounting: AiModelCallRecorder,
  model: DecisionModel,
  callId: string,
  metadata: DecisionModelResponseMetadata
) {
  const usage = metadata.usage ?? {}
  const estimate = estimateModelCall(model, {
    usage,
    route: metadata.route,
    responseModelId: metadata.responseModelId,
  })
  const event = {
    callId,
    providerId: model.providerId,
    modelId: model.modelId,
    responseId: metadata.providerIds?.responseId ?? callId,
    responseModelId: metadata.responseModelId,
    providerIds: metadata.providerIds,
    usage,
    cost: metadata.reportedCost
      ? { status: "reported" as const, ...metadata.reportedCost }
      : estimate,
    ...(metadata.reportedCost ? { estimate } : {}),
    route: metadata.route,
  }

  await accounting.onModelCallEnd(event)
  return event
}
