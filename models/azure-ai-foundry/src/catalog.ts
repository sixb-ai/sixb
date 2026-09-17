import {
  defineLanguageModel,
  defineModelRateCard,
  type LanguageModelRateCard,
  MODEL_REASONING_EFFORTS,
  ModelCatalogUnavailableError,
  type ModelReasoningCapabilities,
} from "@sixb/core/models"
import type { FoundryProtocol } from "./transport"
import { abortable } from "./transport"
import { object, PREFIX } from "./util"

const url = "https://models.dev/api.json"
export interface AzureAIFoundryCatalogOptions {
  readonly ttlMs?: number
  readonly timeoutMs?: number
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}
export interface CatalogModel {
  readonly catalogProvider: "azure" | "fireworks-ai"
  readonly modelName: string
  readonly protocol?: FoundryProtocol
  readonly definition: ReturnType<typeof defineLanguageModel>
  readonly rateCard?: LanguageModelRateCard
}

/** Provider-scoped models.dev snapshot. Construction and offline reads never perform I/O. */
export class RemoteModelsDevCatalog {
  private snapshot: readonly CatalogModel[] = []
  private loadedAt = 0
  private pending?: Promise<readonly CatalogModel[]>
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
    const models = offline ? this.snapshot : await this.load()
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
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 10000)
    let text: string
    try {
      const response = await abortable(
        () => (this.options.fetch ?? fetch)(url, { signal, redirect: "error" }),
        signal
      )
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        for (;;) {
          const chunk = await abortable(() => reader.read(), signal)
          if (chunk.done) break
          bytes += chunk.value.length
          if (bytes > 32 * 1024 * 1024) throw new Error("Catalog exceeds 32 MiB")
          chunks.push(chunk.value)
        }
        text = Buffer.concat(chunks).toString()
      } finally {
        void reader.cancel().catch(() => {})
        reader.releaseLock()
      }
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
      return Object.entries(models).flatMap(([id, value]) => {
        const raw = object(value)
        if (!raw || raw.id !== id)
          throw new TypeError(`${PREFIX} Invalid models.dev model identity.`)
        const modalities = object(raw.modalities)
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
            catalogProvider,
            modelName: id,
            protocol,
            rateCard: rates(object(raw.cost)),
            definition: defineLanguageModel({
              kind: "language",
              providerId: "azure-ai-foundry",
              modelId: id,
              ...(typeof raw.name === "string" ? { name: raw.name } : {}),
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
function rates(raw: Record<string, unknown> | undefined): LanguageModelRateCard | undefined {
  if (!raw || raw.tiers === undefined) return flatRates(raw)
  const { tiers, context_over_200k: legacy, ...base } = raw
  const card = flatRates(base)
  if (!card || !Array.isArray(tiers)) return undefined
  const parsed: { size: number; card: LanguageModelRateCard }[] = []
  for (const value of tiers) {
    const entry = object(value)
    if (!entry) return undefined
    const { tier, ...prices } = entry
    const threshold = object(tier)
    const size = threshold?.size
    const tierCard = flatRates(prices)
    if (
      !tierCard ||
      !threshold ||
      Object.keys(threshold).some((k) => k !== "type" && k !== "size") ||
      (threshold.type !== undefined && threshold.type !== "context") ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size >= Number.MAX_SAFE_INTEGER
    )
      return undefined
    parsed.push({ size, card: tierCard })
  }
  parsed.sort((a, b) => a.size - b.size)
  if (new Set(parsed.map((t) => t.size)).size !== parsed.length) return undefined
  const keys = ["input", "output", "cacheReadInput", "cacheWriteInput"] as const
  if (legacy !== undefined) {
    const mirror = flatRates(object(legacy))
    if (
      !mirror ||
      parsed.length !== 1 ||
      parsed[0]!.size < 200000 ||
      keys.some((k) => mirror[k] !== parsed[0]!.card[k])
    )
      return undefined
  }
  // Missing cache rates are unknown, not inherited or silently treated as zero.
  if (parsed.some((t) => keys.some((k) => (card[k] === undefined) !== (t.card[k] === undefined))))
    return undefined
  const price = (key: (typeof keys)[number]) => {
    const basePrice = card[key]
    if (basePrice === undefined || !parsed.length) return basePrice
    if (typeof basePrice !== "string") return undefined
    return {
      default: basePrice,
      tiers: parsed.map((t, i) => ({
        minTokens: t.size + 1,
        ...(parsed[i + 1] ? { maxTokens: parsed[i + 1]!.size + 1 } : {}),
        price: String(t.card[key]),
      })),
    }
  }
  return defineModelRateCard({
    currency: "USD",
    unit: "million-tokens",
    input: price("input")!,
    output: price("output")!,
    ...(card.cacheReadInput === undefined ? {} : { cacheReadInput: price("cacheReadInput")! }),
    ...(card.cacheWriteInput === undefined ? {} : { cacheWriteInput: price("cacheWriteInput")! }),
  })
}

function flatRates(raw: Record<string, unknown> | undefined): LanguageModelRateCard | undefined {
  if (!raw) return undefined
  // These are reference prices per million tokens. Unrepresented tiers/dimensions must not
  // silently become flat prices; callers can supply an estimator for those billing contracts.
  if (Object.keys(raw).some((k) => !["input", "output", "cache_read", "cache_write"].includes(k)))
    return undefined
  const decimal = (v: unknown) =>
    (typeof v === "number" || typeof v === "string") && /^\d+(\.\d+)?$/.test(String(v))
      ? String(v)
      : undefined
  const input = decimal(raw.input),
    output = decimal(raw.output)
  if (input === undefined || output === undefined) return undefined
  const read = decimal(raw.cache_read),
    write = decimal(raw.cache_write)
  if (
    (raw.cache_read !== undefined && read === undefined) ||
    (raw.cache_write !== undefined && write === undefined)
  )
    return undefined
  return defineModelRateCard({
    currency: "USD",
    unit: "million-tokens",
    input,
    output,
    ...(read === undefined ? {} : { cacheReadInput: read }),
    ...(write === undefined ? {} : { cacheWriteInput: write }),
  })
}
