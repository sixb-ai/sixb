import {
  defineModelRateCard,
  estimateModelReservation,
  type ModelCostEstimator,
  ModelProviderError,
  type ModelRateCard,
  type ModelUsage,
  type RerankingModel,
  type RerankingModelDefinition,
  type RerankingModelRequest,
  RerankingModelResponseError,
  type RerankingModelResponseMetadata,
  type RerankingModelResult,
  type RerankingResult,
  rateModelCall,
} from "@sixb/core/models"
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
import { counter, object, PREFIX, positiveInteger } from "./util"

export interface AzureAIFoundryRerankingOptions {
  /** Deadline for one reranking, response included. Default: 30,000 ms. */
  readonly timeoutMs?: number
  readonly rateCard?: ModelRateCard
  readonly costEstimator?: ModelCostEstimator
}

export interface AzureAIFoundryRerankingModel extends RerankingModel {
  readonly metadata: AzureAIFoundryModelMetadata
  resolve(options?: { readonly offline?: boolean }): Promise<AzureAIFoundryRerankingModel>
}

/** 10,000 scores answer in well under 1 MiB. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** AbortSignal.timeout's largest delay. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

/**
 * Azure Retail Prices (verified 2026-11-13), by deployment SKU: Rerank v5 bills input tokens,
 * USD per million. Rerank v4 bills USD 2 (fast) and 2.50 (pro) per thousand searches, a unit
 * Sixb's rate cards cannot hold yet, so its cost stays unknown.
 */
const PUBLISHED: Readonly<Record<string, Readonly<Record<string, ModelRateCard>>>> = {
  // Rerank V5 Fast {Glbl,DZ} 1M Tokens
  "cohere-rerank-v5-fast": {
    GlobalStandard: { currency: "USD", input: "0.02", output: "0" },
    DataZoneStandard: { currency: "USD", input: "0.022", output: "0" },
  },
  // Rerank V5 Pro {Glbl,DZ} 1M Tokens
  "cohere-rerank-v5-pro": {
    GlobalStandard: { currency: "USD", input: "0.05", output: "0" },
    DataZoneStandard: { currency: "USD", input: "0.055", output: "0" },
  },
}

interface RerankingSettings {
  readonly timeoutMs: number
  readonly rateCard?: ModelRateCard
  readonly costEstimator?: ModelCostEstimator
}

interface RerankingResolution extends ResolvedDeployment {
  readonly costEstimator?: ModelCostEstimator
}

export function createFoundryReranking(
  providerId: string,
  modelId: string,
  options: AzureAIFoundryRerankingOptions,
  transport: FoundryTransport,
  deployments: FoundryDeployments
): AzureAIFoundryRerankingModel {
  if (!modelId.trim() || modelId !== modelId.trim())
    throw new TypeError(`${PREFIX} deploymentName must be nonempty without surrounding whitespace.`)
  positiveInteger(options.timeoutMs, "timeoutMs")
  if (options.timeoutMs !== undefined && options.timeoutMs > MAX_TIMEOUT_MS)
    throw new TypeError(`${PREFIX} timeoutMs must be at most ${MAX_TIMEOUT_MS}.`)
  if (options.rateCard && options.costEstimator)
    throw new TypeError(`${PREFIX} Configure either rateCard or costEstimator, not both.`)
  // Validate and snapshot now: later edits to the caller's object change nothing.
  const settings: RerankingSettings = Object.freeze({
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.rateCard ? { rateCard: defineModelRateCard(options.rateCard) } : {}),
    ...(options.costEstimator ? { costEstimator: options.costEstimator } : {}),
  })
  return rerankingBinding(providerId, modelId, settings, transport, deployments)
}

/** Discovery pins the deployed model for pricing; inference posts Cohere's v2 rerank request. */
function rerankingBinding(
  providerId: string,
  modelId: string,
  settings: RerankingSettings,
  transport: FoundryTransport,
  deployments: FoundryDeployments,
  resolution?: RerankingResolution
): AzureAIFoundryRerankingModel {
  const deployment = resolution?.deployment
  const definition: RerankingModelDefinition = Object.freeze({
    kind: "reranking",
    providerId,
    modelId,
    ...(deployment ? { publisher: azurePublisher(deployment.modelPublisher) } : {}),
    via: "Azure AI Foundry",
  })

  let pending: Promise<AzureAIFoundryRerankingModel> | undefined
  const binding: AzureAIFoundryRerankingModel = Object.freeze({
    providerId,
    modelId,
    definition,
    metadata: deploymentMetadata(resolution),
    ...(resolution?.costEstimator ? { costEstimator: resolution.costEstimator } : {}),

    async resolve(input?: { readonly offline?: boolean }) {
      if (resolution) return binding
      const resolved = await deployments.resolve(modelId, input?.offline === true)
      assertDeploymentKind(resolved.deployment, modelId, "reranking")
      const rateCard = settings.rateCard ?? publishedRateCard(resolved.deployment)
      const costEstimator =
        settings.costEstimator ?? (rateCard ? rerankingEstimator(rateCard) : undefined)
      return rerankingBinding(providerId, modelId, settings, transport, deployments, {
        ...resolved,
        ...(costEstimator ? { costEstimator } : {}),
      })
    },

    async rerank(request: RerankingModelRequest): Promise<RerankingModelResult> {
      const signal = AbortSignal.any([
        ...(request.signal ? [request.signal] : []),
        AbortSignal.timeout(settings.timeoutMs),
      ])
      signal.throwIfAborted()
      if (
        typeof request.query !== "string" ||
        !request.query.trim() ||
        !Array.isArray(request.documents) ||
        request.documents.some((text) => typeof text !== "string" || !text.trim())
      )
        throw new TypeError(`${PREFIX} Reranking requires a query and nonempty document strings.`)
      const documents = [...request.documents]
      if (!documents.length) return { results: [] }
      if (!resolution) {
        // A direct call pins the deployment once, as the runtime does before admission.
        pending ??= binding.resolve().catch((error) => {
          pending = undefined
          throw error
        })
        const resolved = await abortable(() => pending!, signal)
        return resolved.rerank({ query: request.query, documents, signal })
      }

      // Without top_n, Cohere scores every document, which Sixb requires.
      const response = await transport.post(
        JSON.stringify({ model: modelId, query: request.query, documents }),
        signal,
        providerId,
        modelId,
        "reranking"
      )
      const id = transport.redactText(response, requestId(response))
      let body: unknown
      try {
        body = await readJson(response, signal, MAX_RESPONSE_BYTES)
      } catch {
        // The parse error can quote the body; only the status and request ID travel.
        if (signal.aborted) throw signal.reason
        throw new ModelProviderError(
          `${PREFIX} Reranking returned invalid JSON.`,
          providerId,
          modelId,
          { code: "invalid_json", requestId: id, status: response.status }
        )
      }
      const payload = object(body)
      const responseId = typeof payload?.id === "string" && payload.id ? payload.id : undefined
      const metadata: RerankingModelResponseMetadata = {
        usage: rerankingUsage(payload),
        ...(id || responseId
          ? {
              providerIds: {
                ...(id ? { requestId: id } : {}),
                ...(responseId ? { responseId } : {}),
              },
            }
          : {}),
      }
      const results = rerankingResults(payload?.results, documents.length)
      if (!results)
        throw new RerankingModelResponseError(
          `${PREFIX} Invalid reranking response: expected one finite score per document with unique indices.`,
          providerId,
          modelId,
          metadata
        )
      return { ...metadata, results }
    },
  })
  return binding
}

function rerankingResults(value: unknown, count: number): RerankingResult[] | undefined {
  if (!Array.isArray(value) || value.length !== count) return undefined
  const seen = new Set<number>()
  const results: RerankingResult[] = []
  for (const entry of value) {
    const index = object(entry)?.index
    const score = object(entry)?.relevance_score
    if (
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= count ||
      seen.has(index) ||
      typeof score !== "number" ||
      !Number.isFinite(score)
    )
      return undefined
    seen.add(index)
    results.push({ index, score })
  }
  return results
}

/** Rerank v5 bills `input_tokens`; v4 bills `search_units`, kept in `raw` only. */
function rerankingUsage(payload: Record<string, unknown> | undefined): ModelUsage {
  const billed = object(object(payload?.meta)?.billed_units)
  const inputTokens = counter(billed?.input_tokens)
  return {
    ...(inputTokens === undefined ? {} : { inputTokens, outputTokens: 0 }),
    ...(billed ? { raw: billed } : {}),
  }
}

function publishedRateCard(deployment: AzureAIFoundryDeployment): ModelRateCard | undefined {
  const skus = PUBLISHED[deployment.modelName.toLowerCase()]
  const card =
    skus && deployment.modelVersion === "1" && Object.hasOwn(skus, deployment.sku.name)
      ? skus[deployment.sku.name]
      : undefined
  return card ? defineModelRateCard(card) : undefined
}

function rerankingEstimator(rateCard: ModelRateCard): ModelCostEstimator {
  return {
    estimateReservation: (tokens) => estimateModelReservation({ ...tokens, rateCard }),
    estimate: ({ usage }) => {
      // A search-unit bill is not a token bill, whatever the card; a zero count bills nothing.
      const raw = usage.raw ?? {}
      if (Object.entries(raw).some(([key, count]) => key !== "input_tokens" && count !== 0))
        return { status: "unpriceable", reason: "missing-rate-card" }
      return rateModelCall({ usage, rateCard })
    },
  }
}
