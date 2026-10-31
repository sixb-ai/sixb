import {
  defineLanguageModel,
  defineModelRateCard,
  MODEL_REASONING_EFFORTS,
  ModelCatalogUnavailableError,
  type ModelRateCard,
  type ModelReasoningCapabilities,
} from "@sixb/core/models"
import { downloadModelsDev, modelsDevRateCard } from "@sixb/model-protocols/models-dev"
import { fireworksPublisher } from "./publisher"
import type { FoundryProtocol } from "./transport"
import { object, PREFIX } from "./util"

export interface AzureAIFoundryCatalogOptions {
  readonly ttlMs?: number
  readonly timeoutMs?: number
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}
export interface CatalogModel {
  readonly kind: "language"
  readonly catalogProvider: "azure" | "fireworks-ai"
  readonly modelName: string
  readonly protocol?: FoundryProtocol
  readonly definition: ReturnType<typeof defineLanguageModel>
  readonly rateCard?: ModelRateCard
}

export interface CatalogEmbeddingModel {
  readonly kind: "embedding"
  readonly catalogProvider: "azure" | "fireworks-ai"
  readonly modelName: string
  readonly rateCard?: ModelRateCard
}

type CatalogEntry = CatalogModel | CatalogEmbeddingModel

/** Provider-scoped models.dev snapshot. Construction and offline reads never perform I/O. */
export class RemoteModelsDevCatalog {
  private snapshot: readonly CatalogEntry[] = []
  private loadedAt = 0
  private pending?: Promise<readonly CatalogEntry[]>
  private readonly options: AzureAIFoundryCatalogOptions
  constructor(options: AzureAIFoundryCatalogOptions = {}) {
    this.options = { ...options }
    for (const [key, value] of Object.entries({
      ttlMs: this.options.ttlMs,
      timeoutMs: this.options.timeoutMs,
    }))
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || value < (key === "ttlMs" ? 0 : 1))
      )
        throw new TypeError(`${PREFIX} Invalid catalog ${key}.`)
  }
  invalidate() {
    this.loadedAt = 0
  }
  async get(name: string, offline = false): Promise<CatalogModel | undefined> {
    return (await this.lookup(offline))(name)
  }
  async getEmbedding(name: string, offline = false): Promise<CatalogEmbeddingModel | undefined> {
    const models = offline ? this.snapshot : await this.load()
    const matches = models.filter(
      (m): m is CatalogEmbeddingModel =>
        m.kind === "embedding" &&
        m.catalogProvider === "azure" &&
        m.modelName.toLowerCase() === name.toLowerCase()
    )
    return matches.length === 1 ? matches[0] : undefined
  }
  /** Capture one snapshot so a batch of lookups cannot expire between deployments. */
  async lookup(offline = false): Promise<(name: string) => CatalogModel | undefined> {
    const models = (offline ? this.snapshot : await this.load()).filter(
      (m): m is CatalogModel => m.kind === "language"
    )
    return (name) => {
      // Azure deployment names preserve publisher casing; models.dev IDs are lowercase.
      // Only a unique exact case-insensitive ID match is accepted, never fuzzy name matching.
      const matches = models.filter(
        (m) => m.catalogProvider === "azure" && m.modelName.toLowerCase() === name.toLowerCase()
      )
      if (matches.length) return matches.length === 1 ? matches[0] : undefined
      if (!/^FW-/i.test(name)) return undefined
      const identity = normalizeFireworksVersion(name.slice(3).toLowerCase())
      const fallback = models.filter((m) => {
        if (m.catalogProvider !== "fireworks-ai") return false
        const suffix = /^accounts\/fireworks\/(?:models|routers)\/([^/]+)$/.exec(
          m.modelName.toLowerCase()
        )?.[1]
        return (
          suffix !== undefined &&
          !/(?:^|-)latest$/.test(suffix) &&
          normalizeFireworksVersion(suffix) === identity
        )
      })
      return fallback.length === 1 ? fallback[0] : undefined
    }
  }
  private load() {
    if (this.loadedAt && Date.now() - this.loadedAt < (this.options.ttlMs ?? 3600000))
      return Promise.resolve(this.snapshot)
    this.pending ??= this.fetchModels()
      .then((models) => {
        this.snapshot = Object.freeze(models)
        this.loadedAt = Date.now()
        return this.snapshot
      })
      .finally(() => {
        this.pending = undefined
      })
    return this.pending
  }
  private async fetchModels() {
    let text: string
    try {
      text = await downloadModelsDev(this.options)
    } catch (cause) {
      throw new ModelCatalogUnavailableError(`${PREFIX} models.dev catalog unavailable.`, { cause })
    }
    const root = object(JSON.parse(text))
    if (!object(object(root?.azure)?.models))
      throw new TypeError(`${PREFIX} models.dev response is missing azure.models.`)
    return (["azure", "fireworks-ai"] as const).flatMap((catalogProvider) => {
      const providerData = root?.[catalogProvider]
      if (providerData === undefined) return []
      const models = object(object(providerData)?.models)
      if (!models)
        throw new TypeError(`${PREFIX} models.dev response is missing ${catalogProvider}.models.`)
      return Object.entries(models).flatMap<CatalogEntry>(([id, value]) => {
        const raw = object(value)
        if (!raw || raw.id !== id)
          throw new TypeError(`${PREFIX} Invalid models.dev model identity.`)
        const modalities = object(raw.modalities)
        if (
          raw.type === "embedding" ||
          raw.family === "text-embedding" ||
          raw.family === "cohere-embed" ||
          /^(text-embedding-|cohere-embed)/i.test(id) ||
          strings(modalities?.output).includes("embedding")
        ) {
          return [
            {
              kind: "embedding",
              catalogProvider,
              modelName: id,
              rateCard: rates(object(raw.cost), undefined),
            },
          ]
        }
        if (!strings(modalities?.output).includes("text")) return []
        const limits = object(raw.limit)
        const provider = object(raw.provider)
        const protocol =
          catalogProvider === "fireworks-ai"
            ? "chat"
            : provider?.npm === "@ai-sdk/anthropic"
              ? "messages"
              : provider?.shape === "completions" || provider?.npm === "@ai-sdk/openai-compatible"
                ? "chat"
                : undefined
        return [
          {
            kind: "language",
            catalogProvider,
            modelName: id,
            protocol,
            rateCard: rates(object(raw.cost), protocol),
            definition: defineLanguageModel({
              kind: "language",
              providerId: "azure-ai-foundry",
              modelId: id,
              ...(typeof raw.name === "string" ? { name: raw.name } : {}),
              ...(catalogProvider === "fireworks-ai"
                ? { publisher: fireworksPublisher(raw.family) }
                : {}),
              contextWindow: limit(limits?.context),
              maxInputTokens: limit(limits?.input),
              maxOutputTokens: limit(limits?.output),
              capabilities: {
                ...(typeof raw.tool_call === "boolean" ? { localTools: raw.tool_call } : {}),
                ...(typeof raw.structured_output === "boolean"
                  ? { nativeStructuredOutput: raw.structured_output }
                  : {}),
                reasoning: reasoning(raw.reasoning, raw.reasoning_options),
                ...(Array.isArray(modalities?.input)
                  ? {
                      inputMediaTypes: strings(modalities?.input).flatMap((m) =>
                        m === "image"
                          ? ["image/png", "image/jpeg", "image/webp", "image/gif"]
                          : m === "pdf"
                            ? ["application/pdf"]
                            : []
                      ),
                    }
                  : {}),
              },
            }),
          } satisfies CatalogModel,
        ]
      })
    })
  }
}
// Convert numeric version spelling only; keep variant names and dated suffixes intact.
function normalizeFireworksVersion(id: string): string {
  return id.replace(/(\d)p(?=\d)/g, "$1.")
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : []
}
function limit(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}
function reasoning(
  supported: unknown,
  value: unknown
): ModelReasoningCapabilities | false | undefined {
  if (supported === false) return false
  if (supported !== true && !Array.isArray(value)) return undefined
  const options = Array.isArray(value) ? value.map(object).filter((o) => o !== undefined) : []
  const efforts = options.filter((o) => o?.type === "effort").flatMap((o) => strings(o?.values))
  const budget = options.find((o) => o?.type === "budget_tokens")
  return {
    ...(options.some((o) => o?.type === "toggle") || efforts.includes("none")
      ? { canDisable: true }
      : {}),
    ...(efforts.length
      ? { efforts: MODEL_REASONING_EFFORTS.filter((e) => efforts.includes(e)) }
      : {}),
    ...(budget
      ? {
          budgetTokens: {
            ...(limit(budget.min) ? { min: limit(budget.min) } : {}),
            ...(limit(budget.max) ? { max: limit(budget.max) } : {}),
          },
        }
      : {}),
  }
}
function rates(
  raw: Record<string, unknown> | undefined,
  protocol: FoundryProtocol | undefined
): ModelRateCard | undefined {
  const card = modelsDevRateCard(raw)
  if (protocol !== "messages" || card?.cacheWriteInput === undefined) return card
  // models.dev's Messages cache_write is five-minute creation, including in context tiers.
  // One-hour prices are unknown and must not fall back to this rate.
  const { cacheWriteInput, ...rest } = card
  return defineModelRateCard({ ...rest, cacheWriteInput5m: cacheWriteInput })
}
