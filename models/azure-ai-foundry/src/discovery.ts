import {
  type LanguageModelDefinition,
  type LanguageModelDefinitionCatalog,
  ModelCatalogUnavailableError,
  ModelProviderError,
} from "@sixb/core/models"
import { RequestDiagnostics } from "./diagnostics"
import type { FoundryProtocol } from "./transport"
import { abortable, type FoundryTransport, requestId } from "./transport"
import { object, PREFIX, positiveInteger } from "./util"

export interface AzureAIFoundryDiscoveryOptions {
  readonly ttlMs?: number
  /** Deadline for credentials, all pages, and body reads together. Default: 5,000 ms. */
  readonly timeoutMs?: number
  readonly maxPages?: number
  readonly maxDeployments?: number
  /** Aggregate response bytes across all pages. Default: 4 MiB. */
  readonly maxResponseBytes?: number
}

export interface AzureAIFoundryDeployment {
  readonly name: string
  readonly modelName: string
  readonly modelVersion: string
  readonly modelPublisher: string
  readonly connectionName?: string
  readonly capabilities: Readonly<Record<string, string>>
  readonly sku: {
    readonly name: string
    readonly capacity?: number
    readonly family?: string
    readonly size?: string
    readonly tier?: string
  }
}

export interface AzureAIFoundryCatalog extends LanguageModelDefinitionCatalog {
  get(
    name: string,
    options?: { readonly protocol?: FoundryProtocol }
  ): Promise<LanguageModelDefinition | undefined>
  list(options?: {
    readonly protocol?: FoundryProtocol
  }): Promise<readonly LanguageModelDefinition[]>
  refresh(options?: {
    readonly protocol?: FoundryProtocol
  }): Promise<readonly LanguageModelDefinition[]>
  /** All discovered ModelDeployment records, including non-Responses offerings. */
  deployments(): Promise<readonly AzureAIFoundryDeployment[]>
}

interface Snapshot {
  readonly records: readonly AzureAIFoundryDeployment[]
  readonly byName: ReadonlyMap<string, AzureAIFoundryDeployment>
  readonly fetchedAt: string
}

export interface ResolvedDeployment {
  readonly deployment: AzureAIFoundryDeployment
  readonly discoveredAt: string
}

interface DiscoverySettings {
  readonly url: string
  readonly ttlMs: number
  readonly timeoutMs: number
  readonly maxPages: number
  readonly maxDeployments: number
  readonly maxResponseBytes: number
}

export class FoundryDeployments {
  private readonly settings: DiscoverySettings
  private cached?: Snapshot
  private expiresAt = 0
  private pending?: Promise<Snapshot>

  constructor(
    private readonly providerId: string,
    private readonly transport: FoundryTransport,
    discovery: AzureAIFoundryDiscoveryOptions = {}
  ) {
    for (const key of [
      "ttlMs",
      "timeoutMs",
      "maxPages",
      "maxDeployments",
      "maxResponseBytes",
    ] as const)
      positiveInteger(discovery[key], `discovery.${key}`)
    this.settings = {
      url: `${transport.projectUrl}/deployments?api-version=v1`,
      ttlMs: discovery.ttlMs ?? 60 * 60 * 1_000,
      timeoutMs: discovery.timeoutMs ?? 5_000,
      maxPages: discovery.maxPages ?? 100,
      maxDeployments: discovery.maxDeployments ?? 10_000,
      maxResponseBytes: discovery.maxResponseBytes ?? 4 * 1024 * 1024,
    }
  }

  async list(refresh = false): Promise<readonly AzureAIFoundryDeployment[]> {
    return (await this.load(refresh)).records
  }

  async resolve(name: string, offline: boolean): Promise<ResolvedDeployment> {
    const snapshot = offline ? this.cached : await this.load()
    const deployment = snapshot?.byName.get(name)
    if (!snapshot || !deployment)
      throw this.invalid(
        `Deployment '${name}' was not found in ${offline ? "cached project deployments; resolve online first" : "this project"}.`
      )
    return {
      deployment,
      discoveredAt: snapshot.fetchedAt,
    }
  }

  private load(refresh = false): Promise<Snapshot> {
    if (this.pending) return this.pending
    if (!refresh && this.cached && Date.now() < this.expiresAt) return Promise.resolve(this.cached)
    this.pending = this.fetchSnapshot()
      .then((snapshot) => {
        this.cached = snapshot
        this.expiresAt = Date.now() + this.settings.ttlMs
        return snapshot
      })
      .catch((error: unknown) => {
        // Retain the last complete snapshot for explicit offline resolution only.
        this.expiresAt = 0
        throw error
      })
      .finally(() => {
        this.pending = undefined
      })
    return this.pending
  }

  private async fetchSnapshot(): Promise<Snapshot> {
    const settings = this.settings
    const diagnostics = new RequestDiagnostics()
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException("Discovery timed out", "TimeoutError")),
      settings.timeoutMs
    )
    const { signal } = controller
    const records: AzureAIFoundryDeployment[] = []
    const byName = new Map<string, AzureAIFoundryDeployment>()
    const seen = new Set<string>()
    const budget = { bytes: settings.maxResponseBytes }
    let url: string | undefined = settings.url
    let entries = 0
    try {
      while (url !== undefined) {
        const pageUrl: string = this.pageUrl(url, settings.url)
        if (seen.has(pageUrl)) throw this.invalid("Deployment pagination repeated a page.")
        if (seen.size >= settings.maxPages)
          throw this.invalid("Deployment pagination exceeded maxPages.")
        seen.add(pageUrl)
        const response = await this.fetchPage(pageUrl, signal, diagnostics)
        const text = await this.readPage(response, budget, signal)
        let value: unknown
        try {
          value = JSON.parse(text)
        } catch (cause) {
          throw this.invalid("Deployment response is not valid JSON.", cause)
        }
        const page = object(value)
        if (!page || !Array.isArray(page.value))
          throw this.invalid("Deployment response is missing its value array.")
        entries += page.value.length
        if (entries > settings.maxDeployments)
          throw this.invalid("Deployment response exceeded maxDeployments.")
        for (const item of page.value) {
          const raw = object(item)
          if (!raw || typeof raw.type !== "string" || !raw.type.trim())
            throw this.invalid("Deployment record is missing its type.")
          if (raw.type !== "ModelDeployment") continue
          const record = deploymentRecord(raw, (message) => this.invalid(message))
          if (byName.has(record.name))
            throw this.invalid(
              `Duplicate deployment '${record.name}'; deployment names must be unique across project connections.`
            )
          records.push(record)
          byName.set(record.name, record)
        }
        if (
          page.nextLink !== undefined &&
          (typeof page.nextLink !== "string" || !page.nextLink.trim())
        )
          throw this.invalid("Deployment nextLink must be a nonempty URL.")
        url = typeof page.nextLink === "string" ? this.pageUrl(page.nextLink, pageUrl) : undefined
      }
      return { records: Object.freeze(records), byName, fetchedAt: new Date().toISOString() }
    } catch (error) {
      if (error instanceof ModelCatalogUnavailableError)
        throw new ModelCatalogUnavailableError(diagnostics.text(error.message), {
          cause: diagnostics.failure(error.cause),
        })
      throw diagnostics.failure(error)
    } finally {
      clearTimeout(timer)
    }
  }

  private pageUrl(link: string, initial: string): string {
    let url: URL
    try {
      url = new URL(link, initial)
    } catch (cause) {
      throw this.invalid("Invalid deployment nextLink.", cause)
    }
    const base = new URL(initial)
    if (
      url.origin !== base.origin ||
      url.pathname !== base.pathname ||
      url.username ||
      url.password ||
      url.hash
    )
      throw this.invalid("Deployment nextLink must stay on the same project deployments endpoint.")
    if (!url.searchParams.has("api-version")) url.searchParams.set("api-version", "v1")
    if (
      url.searchParams.getAll("api-version").length !== 1 ||
      url.searchParams.get("api-version") !== "v1"
    )
      throw this.invalid("Deployment nextLink must use api-version=v1.")
    url.searchParams.sort()
    return url.href
  }

  private async fetchPage(
    url: string,
    signal: AbortSignal,
    diagnostics: RequestDiagnostics
  ): Promise<Response> {
    let headers: Headers
    try {
      headers = await this.transport.headers(signal, diagnostics)
    } catch (cause) {
      throw this.unavailable(cause)
    }
    headers.set("accept", "application/json")
    let response: Response
    try {
      response = await abortable(async () => {
        const result = await this.transport.fetch(url, { headers, signal, redirect: "error" })
        if (signal.aborted) void result.body?.cancel().catch(() => {})
        return result
      }, signal)
    } catch (cause) {
      throw this.unavailable(cause)
    }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {})
      throw this.unavailable(
        new ModelProviderError(
          `${PREFIX} Deployment discovery failed with HTTP ${response.status}.`,
          this.providerId,
          "catalog",
          { status: response.status, requestId: requestId(response) }
        )
      )
    }
    return response
  }

  private async readPage(
    response: Response,
    budget: { bytes: number },
    signal: AbortSignal
  ): Promise<string> {
    if (!response.body) throw this.invalid("Deployment response has no body.")
    const reader = response.body.getReader()
    const cancel = () => {
      void reader.cancel(signal.reason).catch(() => {})
    }
    signal.addEventListener("abort", cancel, { once: true })
    const chunks: Uint8Array[] = []
    try {
      for (;;) {
        const chunk = await abortable(() => reader.read(), signal).catch((cause: unknown) => {
          throw this.unavailable(cause)
        })
        if (signal.aborted) throw this.unavailable(signal.reason)
        if (chunk.done) return Buffer.concat(chunks).toString("utf8")
        budget.bytes -= chunk.value.byteLength
        if (budget.bytes < 0) throw this.invalid("Deployment response exceeded maxResponseBytes.")
        chunks.push(chunk.value)
      }
    } finally {
      signal.removeEventListener("abort", cancel)
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }

  private invalid(message: string, cause?: unknown): ModelProviderError {
    return new ModelProviderError(`${PREFIX} ${message}`, this.providerId, "catalog", { cause })
  }

  private unavailable(cause: unknown): ModelCatalogUnavailableError {
    return new ModelCatalogUnavailableError(`${PREFIX} Project deployment catalog unavailable.`, {
      cause,
    })
  }
}

const BOOLEAN_KEYS = [
  "responses",
  "chatCompletion",
  "chat_completion",
  "completion",
  "embeddings",
  "jsonObjectResponse",
  "assistants",
]

function deploymentRecord(
  raw: Record<string, unknown>,
  invalid: (message: string) => Error
): AzureAIFoundryDeployment {
  const required = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !value.trim())
      throw invalid(`Deployment ${field} must be a nonempty string.`)
    return value
  }
  const capabilities = object(raw.capabilities)
  if (!capabilities || Object.values(capabilities).some((value) => typeof value !== "string"))
    throw invalid("Deployment capabilities must contain string values.")
  const sku = object(raw.sku)
  if (!sku) throw invalid("Deployment sku must be an object.")
  for (const key of ["family", "size", "tier"])
    if (sku[key] !== undefined && typeof sku[key] !== "string")
      throw invalid(`Deployment sku.${key} must be a string.`)
  if (
    sku.capacity !== undefined &&
    (typeof sku.capacity !== "number" || !Number.isSafeInteger(sku.capacity) || sku.capacity < 0)
  )
    throw invalid("Deployment sku.capacity must be a nonnegative safe integer.")
  if (typeof raw.modelVersion !== "string")
    throw invalid("Deployment modelVersion must be a string.")
  // Entries were validated above. Build a fresh map so callers cannot mutate cached raw metadata.
  const strings = Object.fromEntries(
    Object.entries(capabilities).map(([key, value]) => [key, String(value)])
  )
  for (const key of BOOLEAN_KEYS)
    if (strings[key] !== undefined && !["true", "false"].includes(strings[key]))
      throw invalid(`Deployment capability '${key}' must be 'true' or 'false'.`)
  if (
    strings.chatCompletion !== undefined &&
    strings.chat_completion !== undefined &&
    strings.chatCompletion !== strings.chat_completion
  )
    throw invalid("Deployment has contradictory Chat capability aliases.")
  for (const key of ["maxContextToken", "maxOutputToken"]) {
    if (
      strings[key] !== undefined &&
      (!/^[1-9]\d*$/.test(strings[key]) || !Number.isSafeInteger(Number(strings[key])))
    )
      throw invalid(`Deployment capability '${key}' must be a positive safe integer string.`)
  }
  const name = required(raw.name, "name")
  if (name !== name.trim())
    throw invalid("Deployment name must not contain surrounding whitespace.")
  return Object.freeze({
    name,
    modelName: required(raw.modelName, "modelName"),
    modelVersion: raw.modelVersion,
    modelPublisher: required(raw.modelPublisher, "modelPublisher"),
    ...(raw.connectionName === undefined
      ? {}
      : { connectionName: required(raw.connectionName, "connectionName") }),
    capabilities: Object.freeze(strings),
    sku: Object.freeze({
      name: required(sku.name, "sku.name"),
      ...(typeof sku.capacity === "number" ? { capacity: sku.capacity } : {}),
      ...(typeof sku.family === "string" ? { family: sku.family } : {}),
      ...(typeof sku.size === "string" ? { size: sku.size } : {}),
      ...(typeof sku.tier === "string" ? { tier: sku.tier } : {}),
    }),
  })
}
