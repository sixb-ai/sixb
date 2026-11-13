import {
  type DecisionModel,
  type DecisionModelDefinition,
  type DecisionModelRequest,
  type DecisionModelResult,
  defineModelRateCard,
  type ModelCostEstimator,
  ModelProviderError,
  type ModelRateCard,
} from "@sixb/core/models"
import { systemOneRequest, systemOneResult } from "@sixb/model-protocols/systemone"
import { tokenEstimator } from "./accounting"
import {
  type AzureAIFoundryDeployment,
  deploymentMetadata,
  type FoundryDeployments,
  type ResolvedDeployment,
} from "./discovery"
import { assertDeploymentKind } from "./kinds"
import type { AzureAIFoundryModelMetadata } from "./provider"
import { azurePublisher } from "./publisher"
import { abortable, type FoundryTransport, readJson, requestId } from "./transport"
import { PREFIX, positiveInteger } from "./util"

export interface AzureAIFoundryDecisionOptions {
  /** Deadline for one evaluation, body included. Default: 30,000 ms. */
  readonly timeoutMs?: number
  readonly rateCard?: ModelRateCard
  readonly costEstimator?: ModelCostEstimator
}

export interface AzureAIFoundryDecisionModel extends DecisionModel {
  readonly metadata: AzureAIFoundryModelMetadata
  resolve(options?: { readonly offline?: boolean }): Promise<AzureAIFoundryDecisionModel>
}

/**
 * Azure Retail Prices, meter "Microsoft Decision 1 1M Tokens", USD 0.042 in every region from
 * 2026-10-01 (verified 2026-11-13). The launch post lists output tokens as N/A: one per question.
 */
const DECISION_1_RATE_CARD: ModelRateCard = { currency: "USD", input: "0.042", output: "0" }

/** Microsoft-Decision-1 rejects other sizes with HTTP 400 `unsupported_request_argument`. */
const CAPABILITIES: DecisionModelDefinition["capabilities"] = Object.freeze({
  questions: Object.freeze(["choice", "score", "probability"] as const),
  maxChoices: 255,
  maxScoreLevels: 10,
})

/** 20 questions of 255 options answer in about 200 KB. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

/** AbortSignal.timeout's largest delay. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

interface DecisionSettings {
  readonly timeoutMs: number
  readonly rateCard?: ModelRateCard
  readonly costEstimator?: ModelCostEstimator
}

interface DecisionResolution extends ResolvedDeployment {
  readonly costEstimator: ModelCostEstimator
  /** Lowercase model names the deployment may answer with. */
  readonly models: readonly string[]
}

export function createFoundryDecision(
  providerId: string,
  modelId: string,
  options: AzureAIFoundryDecisionOptions,
  transport: FoundryTransport,
  deployments: FoundryDeployments
): AzureAIFoundryDecisionModel {
  if (!modelId.trim() || modelId !== modelId.trim())
    throw new TypeError(`${PREFIX} deploymentName must be nonempty without surrounding whitespace.`)
  positiveInteger(options.timeoutMs, "timeoutMs")
  if (options.timeoutMs !== undefined && options.timeoutMs > MAX_TIMEOUT_MS)
    throw new TypeError(`${PREFIX} timeoutMs must be at most ${MAX_TIMEOUT_MS}.`)
  if (options.rateCard && options.costEstimator)
    throw new TypeError(`${PREFIX} Configure either rateCard or costEstimator, not both.`)
  // Validate and snapshot now: later edits to the caller's object change nothing.
  const settings: DecisionSettings = Object.freeze({
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.rateCard ? { rateCard: defineModelRateCard(options.rateCard) } : {}),
    ...(options.costEstimator ? { costEstimator: options.costEstimator } : {}),
  })
  return decisionBinding(providerId, modelId, settings, transport, deployments)
}

/** Discovery pins the deployed model for pricing; inference posts System One to the resource. */
function decisionBinding(
  providerId: string,
  modelId: string,
  settings: DecisionSettings,
  transport: FoundryTransport,
  deployments: FoundryDeployments,
  resolution?: DecisionResolution
): AzureAIFoundryDecisionModel {
  const deployment = resolution?.deployment
  const definition: DecisionModelDefinition = Object.freeze({
    kind: "decision",
    providerId,
    modelId,
    ...(deployment ? { publisher: azurePublisher(deployment.modelPublisher) } : {}),
    via: "Azure AI Foundry",
    capabilities: CAPABILITIES,
  })

  let pending: Promise<AzureAIFoundryDecisionModel> | undefined
  const binding: AzureAIFoundryDecisionModel = Object.freeze({
    providerId,
    modelId,
    definition,
    metadata: deploymentMetadata(resolution),
    costEstimator: resolution?.costEstimator,

    async resolve(input?: { readonly offline?: boolean }) {
      if (resolution) return binding
      const resolved = await deployments.resolve(modelId, input?.offline === true)
      const found = resolved.deployment
      assertDeploymentKind(found, modelId, "decision")
      // Azure answers with the lowercase model name, e.g. "microsoft-decision-1".
      const models = [modelId, found.modelName, `${found.modelName}-${found.modelVersion}`].map(
        (name) => name.toLowerCase()
      )
      return decisionBinding(providerId, modelId, settings, transport, deployments, {
        ...resolved,
        models,
        costEstimator:
          settings.costEstimator ?? decisionEstimator(found, settings.rateCard, models),
      })
    },

    async evaluate(request: DecisionModelRequest): Promise<DecisionModelResult> {
      const signal = AbortSignal.any([
        ...(request.signal ? [request.signal] : []),
        AbortSignal.timeout(settings.timeoutMs),
      ])
      signal.throwIfAborted()
      if (!resolution) {
        // A direct call pins the deployment once, as the runtime does before admission.
        pending ??= binding.resolve().catch((error) => {
          pending = undefined
          throw error
        })
        const resolved = await abortable(() => pending!, signal)
        return resolved.evaluate({ ...request, signal })
      }

      const response = await transport.post(
        JSON.stringify(systemOneRequest(modelId, request)),
        signal,
        providerId,
        modelId,
        "decision"
      )
      const id = transport.redactText(response, requestId(response))
      let body: unknown
      try {
        body = await readJson(response, signal, MAX_RESPONSE_BYTES)
      } catch {
        // The parse error can quote the body; only the status and request ID travel.
        if (signal.aborted) throw signal.reason
        throw new ModelProviderError(
          `${PREFIX} Decision model returned invalid JSON.`,
          providerId,
          modelId,
          { code: "invalid_json", requestId: id, status: response.status }
        )
      }
      return systemOneResult(body, request.questions, {
        providerId,
        modelId,
        errorPrefix: PREFIX,
        requestId: id,
        // Answers from another model than the deployment's are not this binding's answers.
        assertModel: (model) => {
          if (typeof model !== "string" || !resolution.models.includes(model.toLowerCase()))
            throw new Error("Unexpected response model")
        },
        redact: (value) => transport.redactText(response, value) ?? value,
      })
    },
  })
  return binding
}

/** Microsoft-Decision-1 version 1 has a published price; any other model stays unknown. */
function decisionEstimator(
  deployment: AzureAIFoundryDeployment,
  rateCard: ModelRateCard | undefined,
  models: readonly string[]
): ModelCostEstimator {
  const { modelName, modelVersion } = deployment
  const published =
    modelName.toLowerCase() === "microsoft-decision-1" && modelVersion === "1"
      ? DECISION_1_RATE_CARD
      : undefined
  const estimator = tokenEstimator(rateCard ?? published, undefined, [], () => true)
  return {
    estimateReservation: estimator.estimateReservation,
    // An answer from another model is never priced at this deployment's rates.
    estimate: (input) => {
      const actual = input.route?.modelId ?? input.responseModelId
      return actual === undefined || models.includes(actual.toLowerCase())
        ? estimator.estimate(input)
        : { status: "unpriceable", reason: "missing-rate-card" }
    },
  }
}
