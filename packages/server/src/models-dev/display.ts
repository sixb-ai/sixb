import { AGENT_REASONING_LEVELS, type AgentReasoningLevel, type LanguageModelRef } from "@sixb/core"
import { z } from "zod"
import catalogJson from "./catalog.json"

const MODELS_DEV_MODELS_URL = "https://models.dev/models.json"
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1_000
const DEFAULT_RETRY_AFTER_MS = 5 * 60 * 1_000
const DEFAULT_FETCH_TIMEOUT_MS = 2_000

const MODEL_MODALITIES = ["text", "image", "audio", "video", "pdf"] as const
type ModelModality = (typeof MODEL_MODALITIES)[number]

interface DisplayCatalogModel {
  readonly name: string
  readonly description?: string
  readonly attachment?: boolean
  readonly reasoning?: boolean
  readonly toolCall?: boolean
  readonly structuredOutput?: boolean
  readonly modalities: {
    readonly input: readonly string[]
    readonly output: readonly string[]
  }
  readonly contextWindowTokens?: number
  readonly reasoningLevels?: readonly string[]
  readonly reasoningToggle?: boolean
}

interface DisplayCatalog {
  readonly publisherNames: Readonly<Record<string, string>>
  readonly models: Readonly<Record<string, DisplayCatalogModel>>
}

export interface LanguageModelDisplay {
  readonly name: string
  readonly description?: string
  readonly publisher: {
    readonly id: string
    readonly name: string
    readonly logoUrl?: string
  }
  readonly via?: string
  readonly capabilities: {
    readonly input: readonly ModelModality[]
    readonly output: readonly ModelModality[]
    readonly attachments?: boolean
    readonly reasoning?: boolean
    readonly tools?: boolean
    readonly structuredOutput?: boolean
    readonly contextWindowTokens?: number
  }
  readonly reasoningLevels: readonly AgentReasoningLevel[]
}

export interface ModelsDevDisplayResolverOptions {
  readonly fetch?: ModelsDevFetch | null
  readonly now?: () => number
  readonly cacheTtlMs?: number
  readonly retryAfterMs?: number
  readonly fetchTimeoutMs?: number
  readonly onRefreshError?: (error: unknown) => void
}

export interface LanguageModelDisplayResolver {
  resolveAll(models: readonly LanguageModelRef[]): Promise<readonly LanguageModelDisplay[]>
}

type ModelsDevFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const reasoningOptionSchema = z.object({
  type: z.string(),
  values: z.array(z.string().nullable()).optional(),
})

const remoteModelSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().nullish(),
  attachment: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z.array(reasoningOptionSchema).optional(),
  tool_call: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  modalities: z
    .object({
      input: z.array(z.string()),
      output: z.array(z.string()),
    })
    .optional(),
  limit: z.object({ context: z.number().int().nonnegative().optional() }).optional(),
})

const bundledCatalog: DisplayCatalog = {
  publisherNames: catalogJson.publisherNames,
  models: catalogJson.models,
}
const validReasoningLevels = new Set<string>(AGENT_REASONING_LEVELS)
const validModalities = new Set<string>(MODEL_MODALITIES)
const acronyms: Readonly<Record<string, string>> = { ai: "AI", api: "API", llm: "LLM" }

/**
 * Resolve display-only model metadata from a bounded, in-process Models.dev cache.
 * The embedded snapshot remains available when refreshes time out or fail validation.
 */
export class ModelsDevDisplayResolver implements LanguageModelDisplayResolver {
  private readonly fetch: ModelsDevFetch | null
  private readonly now: () => number
  private readonly cacheTtlMs: number
  private readonly retryAfterMs: number
  private readonly fetchTimeoutMs: number
  private readonly onRefreshError: (error: unknown) => void
  private catalog: DisplayCatalog = bundledCatalog
  private etag: string | undefined
  private refreshAfterMs = 0
  private pendingRefresh: Promise<void> | null = null

  constructor(options: ModelsDevDisplayResolverOptions = {}) {
    this.fetch = options.fetch === undefined ? globalThis.fetch : options.fetch
    this.now = options.now ?? Date.now
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    this.onRefreshError =
      options.onRefreshError ??
      ((error) => {
        console.warn(
          "[SixbServer] Could not refresh Models.dev display metadata; using cached metadata.",
          error
        )
      })
  }

  async resolveAll(models: readonly LanguageModelRef[]): Promise<readonly LanguageModelDisplay[]> {
    const catalog = await this.currentCatalog()
    return models.map((model) => resolveLanguageModelDisplay(model, catalog))
  }

  private async currentCatalog(): Promise<DisplayCatalog> {
    const fetch = this.fetch
    if (fetch === null || this.now() < this.refreshAfterMs) return this.catalog

    const refresh = this.pendingRefresh ?? this.refresh(fetch)
    this.pendingRefresh = refresh
    try {
      await refresh
    } finally {
      if (this.pendingRefresh === refresh) this.pendingRefresh = null
    }
    return this.catalog
  }

  private async refresh(fetch: ModelsDevFetch): Promise<void> {
    try {
      const result = await fetchModelsDevCatalog(fetch, this.etag, this.fetchTimeoutMs)
      if (result.kind === "notModified") {
        this.etag = result.etag ?? this.etag
        this.refreshAfterMs = this.now() + this.cacheTtlMs
        return
      }

      const remoteModels = parseRemoteModels(result.body)
      this.catalog = {
        publisherNames: bundledCatalog.publisherNames,
        models: mergeDisplayModels(bundledCatalog.models, remoteModels),
      }
      this.etag = result.etag
      this.refreshAfterMs = this.now() + this.cacheTtlMs
    } catch (error) {
      this.refreshAfterMs = this.now() + this.retryAfterMs
      this.onRefreshError(error)
    }
  }
}

function mergeDisplayModels(
  fallback: DisplayCatalog["models"],
  current: DisplayCatalog["models"]
): DisplayCatalog["models"] {
  const merged: Record<string, DisplayCatalogModel> = { ...fallback }
  for (const [id, model] of Object.entries(current)) {
    // models.json owns common capabilities, while provider-specific reasoning controls currently
    // live in api.json and are retained from the generated fallback when absent from this feed.
    merged[id] = { ...fallback[id], ...model }
  }
  return merged
}

function resolveLanguageModelDisplay(
  model: LanguageModelRef,
  catalog: DisplayCatalog
): LanguageModelDisplay {
  const canonicalId = resolveCanonicalModelId(model, catalog)
  const metadata = canonicalId ? catalog.models[canonicalId] : undefined
  const publisherId = publisherIdFor(model, canonicalId)
  const publisherName = catalog.publisherNames[publisherId] ?? humanizeId(publisherId)
  const reasoningLevels = resolveReasoningLevels(metadata)

  return {
    name: metadata?.name ?? humanizeId(model.modelId.split("/").at(-1) ?? model.modelId),
    ...(metadata?.description ? { description: metadata.description } : {}),
    publisher: {
      id: publisherId,
      name: publisherName,
      ...(metadata
        ? { logoUrl: `https://models.dev/logos/${encodeURIComponent(publisherId)}.svg` }
        : {}),
    },
    ...(isAiGateway(model.provider) ? { via: "AI Gateway" } : {}),
    capabilities: {
      input: modalities(metadata?.modalities.input),
      output: modalities(metadata?.modalities.output),
      ...(metadata?.attachment === undefined ? {} : { attachments: metadata.attachment }),
      ...(metadata?.reasoning === undefined ? {} : { reasoning: metadata.reasoning }),
      ...(metadata?.toolCall === undefined ? {} : { tools: metadata.toolCall }),
      ...(metadata?.structuredOutput === undefined
        ? {}
        : { structuredOutput: metadata.structuredOutput }),
      ...(metadata?.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: metadata.contextWindowTokens }),
    },
    reasoningLevels,
  }
}

function resolveCanonicalModelId(
  model: LanguageModelRef,
  catalog: DisplayCatalog
): string | undefined {
  if (Object.hasOwn(catalog.models, model.modelId)) return model.modelId

  // AI Gateway keeps dotted marketing versions for some models while Models.dev canonicalizes
  // the same version segments with hyphens (for example Claude Sonnet 4.6).
  const normalizedModelId = model.modelId.replace(/(?<=\d)\.(?=\d)/g, "-")
  if (normalizedModelId !== model.modelId && Object.hasOwn(catalog.models, normalizedModelId)) {
    return normalizedModelId
  }

  const providerId = model.provider.split(".")[0]
  if (!providerId) return undefined
  const candidate = `${providerId}/${model.modelId}`
  if (Object.hasOwn(catalog.models, candidate)) return candidate

  const normalizedCandidate = `${providerId}/${normalizedModelId}`
  return Object.hasOwn(catalog.models, normalizedCandidate) ? normalizedCandidate : undefined
}

function publisherIdFor(model: LanguageModelRef, canonicalId: string | undefined): string {
  const id = canonicalId ?? model.modelId
  const separator = id.indexOf("/")
  if (separator > 0) return id.slice(0, separator)
  return model.provider.split(".")[0] || "model"
}

function resolveReasoningLevels(
  metadata: DisplayCatalogModel | undefined
): readonly AgentReasoningLevel[] {
  if (!metadata?.reasoning) return []

  const levels: AgentReasoningLevel[] = ["provider-default"]
  if (metadata.reasoningToggle) levels.push("none")
  for (const level of metadata.reasoningLevels ?? []) {
    const normalized = level === "default" ? "provider-default" : level
    if (
      validReasoningLevels.has(normalized) &&
      !levels.includes(normalized as AgentReasoningLevel)
    ) {
      levels.push(normalized as AgentReasoningLevel)
    }
  }
  return levels
}

function parseRemoteModels(value: unknown): Readonly<Record<string, DisplayCatalogModel>> {
  if (!isRecord(value)) {
    throw new Error("[SixbServer] Models.dev returned an invalid model catalog.")
  }

  const models: Record<string, DisplayCatalogModel> = {}
  for (const [id, candidate] of Object.entries(value)) {
    const parsed = remoteModelSchema.safeParse(candidate)
    if (!parsed.success) continue

    const reasoningOptions = parsed.data.reasoning_options ?? []
    const reasoningLevels = [
      ...new Set(
        reasoningOptions.flatMap((option) =>
          option.type === "effort" && option.values
            ? option.values.filter((level): level is string => level !== null)
            : []
        )
      ),
    ]
    const contextWindowTokens = parsed.data.limit?.context
    models[id] = {
      name: parsed.data.name,
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      ...(parsed.data.attachment === undefined ? {} : { attachment: parsed.data.attachment }),
      ...(parsed.data.reasoning === undefined ? {} : { reasoning: parsed.data.reasoning }),
      ...(parsed.data.tool_call === undefined ? {} : { toolCall: parsed.data.tool_call }),
      ...(parsed.data.structured_output === undefined
        ? {}
        : { structuredOutput: parsed.data.structured_output }),
      modalities: parsed.data.modalities ?? { input: [], output: [] },
      ...(contextWindowTokens === undefined || contextWindowTokens === 0
        ? {}
        : { contextWindowTokens }),
      ...(reasoningLevels.length === 0 ? {} : { reasoningLevels }),
      ...(reasoningOptions.some((option) => option.type === "toggle")
        ? { reasoningToggle: true }
        : {}),
    }
  }

  if (Object.keys(models).length === 0) {
    throw new Error("[SixbServer] Models.dev returned no valid model metadata.")
  }
  return models
}

type ModelsDevFetchResult =
  | { readonly kind: "notModified"; readonly etag?: string }
  | { readonly kind: "updated"; readonly etag?: string; readonly body: unknown }

async function fetchModelsDevCatalog(
  fetch: ModelsDevFetch,
  etag: string | undefined,
  timeoutMs: number
): Promise<ModelsDevFetchResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(MODELS_DEV_MODELS_URL, {
      headers: etag ? { "if-none-match": etag } : undefined,
      signal: controller.signal,
    })
    const responseEtag = response.headers.get("etag") ?? undefined
    if (response.status === 304) return { kind: "notModified", etag: responseEtag }
    if (!response.ok) {
      throw new Error(`[SixbServer] Models.dev returned HTTP ${response.status}.`)
    }
    return { kind: "updated", etag: responseEtag, body: await response.json() }
  } finally {
    clearTimeout(timeout)
  }
}

function modalities(values: readonly string[] | undefined): readonly ModelModality[] {
  return (values ?? []).filter((value): value is ModelModality => validModalities.has(value))
}

function isAiGateway(provider: string): boolean {
  return provider === "gateway" || provider === "gateway.language-model"
}

function humanizeId(value: string): string {
  return value
    .split(/[-_.]/g)
    .filter(Boolean)
    .map(
      (part) => acronyms[part.toLowerCase()] ?? `${part.charAt(0).toUpperCase()}${part.slice(1)}`
    )
    .join(" ")
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
