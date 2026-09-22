import {
  defineModelRateCard,
  type EmbeddingModel,
  type EmbeddingModelDefinition,
  type EmbeddingModelRequest,
  EmbeddingModelResponseError,
  type EmbeddingModelResponseMetadata,
  type EmbeddingModelResult,
  type JsonObject,
  type LanguageModelRateCard,
  ModelCatalogUnavailableError,
  type ModelCostEstimator,
  type ModelUsage,
  UnsupportedModelFeatureError,
} from "@sixb/core/models"
import { tokenEstimator } from "./accounting"
import type { CatalogEmbeddingModel, RemoteModelsDevCatalog } from "./catalog"
import type { AzureAIFoundryDeployment, FoundryDeployments, ResolvedDeployment } from "./discovery"
import type { AzureAIFoundryModelMetadata } from "./provider"
import { abortable, type FoundryTransport, requestId, type TransportOptions } from "./transport"
import { counter, object, PREFIX } from "./util"

export type AzureAIFoundryEmbeddingTransportOptions = Pick<
  TransportOptions,
  "endpoint" | "apiKey" | "headers" | "fetch"
>

export interface AzureAIFoundryEmbeddingOptions {
  /** Pin the actual model behind the deployment; discovery must match before inference. */
  readonly model: { readonly name: string; readonly version: string }
  /** Expected output size; sent to text-embedding-3 models, validated locally for ada-002. */
  readonly dimensions: number
  readonly rateCard?: LanguageModelRateCard
  readonly costEstimator?: ModelCostEstimator
}

export interface AzureAIFoundryEmbeddingModel extends EmbeddingModel {
  readonly metadata: AzureAIFoundryModelMetadata
  resolve(options?: { readonly offline?: boolean }): Promise<AzureAIFoundryEmbeddingModel>
}

interface EmbeddingResolution extends ResolvedDeployment {
  readonly costEstimator: ModelCostEstimator
  readonly configurableDimensions: boolean
}

/** Discovery uses project credentials; inference uses only the explicit resource transport. */
export function createFoundryEmbedding(
  providerId: string,
  modelId: string,
  options: AzureAIFoundryEmbeddingOptions,
  transport: FoundryTransport,
  deployments: FoundryDeployments,
  catalog: RemoteModelsDevCatalog,
  resolution?: EmbeddingResolution
): AzureAIFoundryEmbeddingModel {
  const dimensions = options.dimensions
  const expected = options.model
  if (
    !expected ||
    [expected.name, expected.version].some(
      (value) => typeof value !== "string" || !value || value.trim() !== value
    )
  ) {
    throw new TypeError(
      `${PREFIX} Embedding deployments require an expected model name and version.`
    )
  }
  const representation = Object.freeze({ name: expected.name, version: expected.version })
  const definition = Object.freeze({
    kind: "embedding" as const,
    providerId,
    modelId,
    dimensions,
    representation,
  })
  if (
    !modelId ||
    modelId.trim() !== modelId ||
    !Number.isSafeInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > 16000
  )
    throw new TypeError(
      `${PREFIX} Embedding models require a nonempty deployment name and dimensions between 1 and 16000.`
    )
  if (options.rateCard && options.costEstimator)
    throw new TypeError(`${PREFIX} Configure either rateCard or costEstimator, not both.`)
  const settings = Object.freeze({
    model: representation,
    dimensions,
    rateCard: options.rateCard && defineModelRateCard(options.rateCard),
    costEstimator: options.costEstimator,
  })
  const deployment = resolution?.deployment
  const metadata = Object.freeze(
    deployment
      ? {
          deployment,
          modelName: deployment.modelName,
          modelVersion: deployment.modelVersion,
          publisher: deployment.modelPublisher,
          sku: deployment.sku.name,
          discoveredAt: resolution.discoveredAt,
        }
      : {}
  )
  let pending: Promise<AzureAIFoundryEmbeddingModel> | undefined
  const binding: AzureAIFoundryEmbeddingModel = Object.freeze({
    providerId,
    modelId,
    definition,
    // OpenAI byte-level tokenization emits at most one token per UTF-8 byte.
    // These conservative bounds avoid requiring a tokenizer for projection batching.
    batching: Object.freeze({ maxInputs: 2048, maxInputBytes: 8191, maxTotalInputBytes: 300000 }),
    metadata,
    costEstimator: resolution?.costEstimator,
    async resolve(input?: { readonly offline?: boolean }) {
      if (resolution) return binding
      const resolved = await deployments.resolve(modelId, input?.offline === true)
      if (
        resolved.deployment.modelName !== representation.name ||
        resolved.deployment.modelVersion !== representation.version
      ) {
        throw new TypeError(
          `${PREFIX} Embedding deployment '${modelId}' resolved to ${resolved.deployment.modelName}@${resolved.deployment.modelVersion}; expected ${representation.name}@${representation.version}.`
        )
      }
      const configurableDimensions = validateDeployment(resolved, dimensions)
      let entry: CatalogEmbeddingModel | undefined
      try {
        entry = await catalog.getEmbedding(resolved.deployment.modelName, input?.offline)
      } catch (error) {
        if (!(error instanceof ModelCatalogUnavailableError)) throw error
        entry = await catalog.getEmbedding(resolved.deployment.modelName, true)
        console.warn(
          `${PREFIX} Embedding pricing catalog unavailable; using cached or explicit pricing when available.`
        )
      }
      const costEstimator =
        settings.costEstimator ??
        tokenEstimator(
          settings.rateCard ?? entry?.rateCard,
          undefined,
          [],
          (raw) =>
            !raw ||
            Object.keys(raw).every(
              (key) =>
                ["prompt_tokens", "total_tokens"].includes(key) && counter(raw[key]) !== undefined
            ),
          resolved.deployment.modelName,
          resolved.deployment.modelVersion,
          [
            modelId,
            resolved.deployment.modelName,
            `${resolved.deployment.modelName}-${resolved.deployment.modelVersion}`,
          ]
        )
      return createFoundryEmbedding(
        providerId,
        modelId,
        settings,
        transport,
        deployments,
        catalog,
        {
          ...resolved,
          configurableDimensions,
          costEstimator,
        }
      )
    },
    async embed(input: EmbeddingModelRequest): Promise<EmbeddingModelResult> {
      const signal = input.signal ?? AbortSignal.timeout(30_000)
      signal.throwIfAborted()
      if (
        !Array.isArray(input.texts) ||
        input.texts.length > 2048 ||
        Array.from(input.texts).some((text) => typeof text !== "string" || !text.trim())
      )
        throw new TypeError(
          `${PREFIX} Embedding inputs must contain at most 2048 nonempty strings.`
        )
      const texts = [...input.texts]
      if (!texts.length) return { vectors: [] }
      if (!resolution) {
        pending ??= binding.resolve().catch((error) => {
          pending = undefined
          throw error
        })
        const resolved = await abortable(() => pending!, signal)
        return resolved.embed({ texts, signal })
      }
      const response = await transport.post(
        JSON.stringify({
          model: modelId,
          input: texts,
          encoding_format: "float",
          ...(resolution.configurableDimensions ? { dimensions } : {}),
        }),
        signal,
        providerId,
        modelId,
        "embeddings"
      )
      return readEmbeddingResult(response, transport, signal, {
        ...definition,
        count: texts.length,
        deployment: resolution.deployment,
      })
    },
  })
  return binding
}

function validateDeployment(resolved: ResolvedDeployment, dimensions: number): boolean {
  const deployment = resolved.deployment
  const name = deployment.modelName.toLowerCase()
  const maxDimensions =
    name === "text-embedding-3-small"
      ? 1536
      : name === "text-embedding-3-large"
        ? 3072
        : name === "text-embedding-ada-002"
          ? 1536
          : undefined
  if (
    deployment.modelPublisher.toLowerCase() !== "openai" ||
    !maxDimensions ||
    deployment.capabilities.embeddings === "false" ||
    deployment.capabilities.embedding === "false"
  )
    throw new UnsupportedModelFeatureError(
      `${PREFIX} This embedding deployment is not supported. Use an OpenAI text-embedding-3-small, text-embedding-3-large, or text-embedding-ada-002 deployment.`
    )
  const configurable = name !== "text-embedding-ada-002"
  if (dimensions > maxDimensions || (!configurable && dimensions !== maxDimensions))
    throw new TypeError(
      `${PREFIX} ${name} requires ${configurable ? `1–${maxDimensions}` : maxDimensions} dimensions.`
    )
  return configurable
}

function parseVectors(
  data: unknown,
  count: number,
  dimensions: number,
  invalid: () => Error
): number[][] {
  if (!Array.isArray(data) || data.length !== count) throw invalid()
  const vectors: number[][] = new Array(count)
  for (const value of data) {
    const entry = record(value)
    const index = counter(entry?.index)
    const embedding = entry?.embedding
    if (
      index === undefined ||
      index >= count ||
      vectors[index] !== undefined ||
      !Array.isArray(embedding) ||
      embedding.length !== dimensions
    )
      throw invalid()
    const vector: number[] = []
    for (const n of embedding) {
      if (typeof n !== "number" || !Number.isFinite(Math.fround(n))) throw invalid()
      vector.push(n)
    }
    if (!vector.some((n) => Math.fround(n) !== 0)) throw invalid()
    vectors[index] = vector
  }
  return vectors
}

function invalidResponse(
  providerId: string,
  modelId: string,
  metadata: EmbeddingModelResponseMetadata
) {
  return new EmbeddingModelResponseError(
    `${PREFIX} Invalid embedding response: expected the resolved model and one finite, nonzero vector of the configured dimension per input, with unique indices.`,
    providerId,
    modelId,
    metadata
  )
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Empty embedding response")
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await abortable(() => reader.read(), signal)
      if (chunk.done) break
      bytes += chunk.value.length
      if (bytes > 128 * 1024 * 1024) throw new Error("Embedding response exceeds 128 MiB")
      chunks.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function embeddingUsage(raw: JsonObject | undefined): ModelUsage {
  const inputTokens = counter(raw?.prompt_tokens)
  const totalTokens = counter(raw?.total_tokens)
  const knownInput =
    inputTokens !== undefined && (raw?.total_tokens === undefined || totalTokens === inputTokens)
  // Retain numeric billing evidence only; unexpected meters prevent automatic pricing.
  const unsupported =
    raw &&
    Object.entries(raw).some(
      ([key, value]) =>
        !["prompt_tokens", "total_tokens"].includes(key) || counter(value) === undefined
    )
  return {
    ...(knownInput ? { inputTokens, uncachedInputTokens: inputTokens } : {}),
    outputTokens: 0,
    ...(raw
      ? {
          raw: {
            ...(inputTokens === undefined ? {} : { prompt_tokens: inputTokens }),
            ...(totalTokens === undefined ? {} : { total_tokens: totalTokens }),
            ...(unsupported ? { unsupported: true } : {}),
          },
        }
      : {}),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

async function readEmbeddingResult(
  response: Response,
  transport: FoundryTransport,
  signal: AbortSignal,
  expected: EmbeddingModelDefinition & { count: number; deployment: AzureAIFoundryDeployment }
): Promise<EmbeddingModelResult> {
  const { providerId, modelId, dimensions } = expected
  const facts: EmbeddingModelResponseMetadata = {
    providerIds: { requestId: transport.redactText(response, requestId(response)) },
  }
  let body: Record<string, unknown> | undefined
  try {
    body = record(await readResponse(response, signal))
  } catch {
    if (signal.aborted) throw signal.reason
    throw invalidResponse(providerId, modelId, facts)
  }
  const resultMetadata: EmbeddingModelResponseMetadata = {
    ...facts,
    usage: embeddingUsage(object(body?.usage)),
    responseModelId:
      typeof body?.model === "string" ? transport.redactText(response, body.model) : undefined,
  }
  const name = expected.deployment.modelName
  if (
    !body ||
    ![modelId, name, `${name}-${expected.deployment.modelVersion}`].includes(String(body.model))
  )
    throw invalidResponse(providerId, modelId, resultMetadata)
  return {
    ...resultMetadata,
    vectors: parseVectors(body.data, expected.count, dimensions, () =>
      invalidResponse(providerId, modelId, resultMetadata)
    ),
  }
}
