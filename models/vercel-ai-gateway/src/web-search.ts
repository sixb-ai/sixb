import {
  isJsonObject,
  type JsonObject,
  type ModelMoney,
  ModelProviderError,
  type WebSearchHit,
  type WebSearchModel,
  type WebSearchModelRequest,
  WebSearchModelResponseError,
  type WebSearchModelResponseMetadata,
} from "@sixb/core/models"

/** The search engines Gateway runs as a provider tool. */
export type VercelGatewayWebSearchEngine = "perplexity" | "exa" | "parallel"

export interface VercelGatewayWebSearchOptions {
  /** The most results one search returns, from 1 to 10. Defaults to 8. */
  readonly maxResults?: number
  /**
   * The language model Gateway runs the search tool through. Defaults to
   * `google/gemini-2.5-flash-lite`. Another one is not priced before the call, so a cost limit
   * blocks its searches.
   */
  readonly wrapperModel?: string
}

/** What the binding needs of the provider: where to send the request, and how to read its reply. */
export interface GatewayWebSearchTransport {
  url(): string
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  headers(): Record<string, string>
  /** The provider's own error for a failed HTTP reply: status, code and whether to retry. */
  httpError(response: Response, modelId: string): Promise<ModelProviderError>
  /** Usage, ids and the cost Gateway reports, read from a reply. */
  metadata(payload: JsonObject, requestId: string | undefined): WebSearchModelResponseMetadata
}

const PROVIDER_ID = "vercel-ai-gateway"
const DEFAULT_WRAPPER_MODEL = "google/gemini-2.5-flash-lite"
const DEFAULT_MAX_RESULTS = 8
const MAX_DOMAINS = 20

// Measured per search with the default wrapper: perplexity ~$0.0055, exa ~$0.0075, parallel
// ~$0.0052, each wrapper share included. The ceiling leaves room for a longer reply to the wrapper.
const RESERVATIONS: Readonly<Record<VercelGatewayWebSearchEngine, string>> = {
  perplexity: "7000000",
  exa: "10000000",
  parallel: "7000000",
}

interface EngineProtocol {
  args(request: WebSearchModelRequest, maxResults: number): JsonObject
  hit(raw: JsonObject): WebSearchHit
}

const ENGINES: Readonly<Record<VercelGatewayWebSearchEngine, EngineProtocol>> = {
  perplexity: {
    args: (request, maxResults) => ({
      query: request.query,
      maxResults,
      ...domainFilter(request, (include, domains) => ({
        searchDomainFilter: include ? domains : domains.map((domain) => `-${domain}`),
      })),
    }),
    hit: (raw) => ({
      url: string(raw.url),
      title: string(raw.title),
      snippet: string(raw.snippet),
      ...dated(raw.date),
    }),
  },
  exa: {
    args: (request, maxResults) => ({
      query: request.query,
      numResults: maxResults,
      contents: { highlights: true },
      ...domainFilter(request, (include, domains) => ({
        [include ? "includeDomains" : "excludeDomains"]: domains,
      })),
    }),
    hit: (raw) => ({
      url: string(raw.url),
      title: string(raw.title),
      snippet: strings(raw.highlights).join(" … ") || string(raw.summary) || string(raw.text),
      ...dated(raw.publishedDate),
    }),
  },
  parallel: {
    args: (request, maxResults) => ({
      objective: request.query,
      searchQueries: [request.query],
      maxResults,
      ...domainFilter(request, (include, domains) => ({
        sourcePolicy: { [include ? "includeDomains" : "excludeDomains"]: domains },
      })),
    }),
    hit: (raw) => ({
      url: string(raw.url),
      title: string(raw.title),
      snippet: strings(raw.excerpts).join(" … "),
      ...dated(raw.publish_date),
    }),
  },
}

/**
 * Gateway has no search endpoint: a search is a language-model call forced to use one provider
 * tool, whose arguments pin the query. The tool's raw results come back in the reply, and its
 * cost, wrapper included, in the Gateway metadata.
 */
export function createGatewayWebSearch(
  engine: VercelGatewayWebSearchEngine,
  options: VercelGatewayWebSearchOptions,
  transport: GatewayWebSearchTransport
): WebSearchModel {
  const protocol = Object.hasOwn(ENGINES, engine) ? ENGINES[engine] : undefined
  if (!protocol) {
    throw new TypeError(
      `[SixbVercelGateway] Unknown web search engine '${String(engine)}'. Use ${Object.keys(ENGINES).join(", ")}.`
    )
  }

  const ceiling = options.maxResults ?? DEFAULT_MAX_RESULTS
  if (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > 10) {
    throw new TypeError("[SixbVercelGateway] webSearch maxResults must be an integer from 1 to 10.")
  }

  const wrapperModel = options.wrapperModel ?? DEFAULT_WRAPPER_MODEL
  if (!wrapperModel || wrapperModel.trim() !== wrapperModel) {
    throw new TypeError("[SixbVercelGateway] webSearch wrapperModel must be a nonempty model id.")
  }

  const modelId = `${engine}/search`
  const toolName = `${engine}_search`
  const reservation: ModelMoney | undefined =
    wrapperModel === DEFAULT_WRAPPER_MODEL
      ? { currency: "USD", amountNanos: RESERVATIONS[engine] }
      : undefined

  return Object.freeze({
    providerId: PROVIDER_ID,
    modelId,
    definition: Object.freeze({ kind: "web-search" as const, providerId: PROVIDER_ID, modelId }),
    costEstimator: Object.freeze({
      estimateReservation: () => reservation,
      // No rate card prices a search: its cost is the one Gateway reports.
      estimate: () => ({ status: "unpriceable" as const, reason: "missing-rate-card" as const }),
    }),

    async search(request: WebSearchModelRequest) {
      request.signal?.throwIfAborted()

      const maxResults = Math.min(request.maxResults, ceiling)
      const response = await transport.fetch(transport.url(), {
        method: "POST",
        headers: {
          ...transport.headers(),
          "content-type": "application/json",
          "ai-gateway-protocol-version": "0.0.1",
          "ai-language-model-specification-version": "4",
          "ai-language-model-id": wrapperModel,
          "ai-language-model-streaming": "false",
        },
        body: JSON.stringify({
          prompt: [
            {
              role: "system",
              content: "Call the search tool once with the user's message as its query.",
            },
            { role: "user", content: [{ type: "text", text: request.query }] },
          ],
          tools: [
            {
              type: "provider",
              id: `gateway.${toolName}`,
              name: toolName,
              args: protocol.args(request, maxResults),
            },
          ],
          toolChoice: { type: "tool", toolName },
          maxOutputTokens: 100,
        }),
        signal: request.signal,
      })
      if (!response.ok) throw await transport.httpError(response, modelId)

      const requestId = response.headers.get("x-request-id") ?? undefined
      let payload: JsonObject
      try {
        const body: unknown = await response.json()
        if (!isJsonObject(body)) throw new TypeError("expected an object")
        payload = body
      } catch (cause) {
        throw new ModelProviderError(
          "[SixbVercelGateway] Web search returned invalid JSON.",
          PROVIDER_ID,
          modelId,
          { code: "invalid_json", ...(requestId === undefined ? {} : { requestId }), cause }
        )
      }

      const metadata = transport.metadata(payload, requestId)
      const invalid = (detail: string) =>
        new WebSearchModelResponseError(
          `[SixbVercelGateway] Web search ${detail}.`,
          PROVIDER_ID,
          modelId,
          metadata
        )

      const content = Array.isArray(payload.content) ? payload.content : []
      const part = content.find(
        (entry): entry is JsonObject => isJsonObject(entry) && entry.type === "tool-result"
      )
      if (!part) throw invalid("did not run: Gateway's model did not call the search tool")

      const result = isJsonObject(part.result) ? part.result : undefined
      if (part.isError === true || !result || typeof result.error === "string") {
        const message = result && typeof result.message === "string" ? `: ${result.message}` : ""
        throw invalid(`failed${message}`)
      }
      if (!Array.isArray(result.results)) throw invalid("returned no list of results")

      return {
        ...metadata,
        // Core checks each hit and drops one without a web URL.
        results: result.results.filter(isJsonObject).map(protocol.hit),
      }
    },
  })
}

/**
 * The allowed domains when there are some, else the blocked ones: an engine takes one list, and
 * Sixb filters the results against both again.
 */
function domainFilter(
  request: WebSearchModelRequest,
  filter: (include: boolean, domains: string[]) => JsonObject
): JsonObject {
  const allowed = request.allowedDomains?.slice(0, MAX_DOMAINS) ?? []
  if (allowed.length > 0) return filter(true, allowed)

  const blocked = request.blockedDomains?.slice(0, MAX_DOMAINS) ?? []
  return blocked.length > 0 ? filter(false, blocked) : {}
}

function dated(value: unknown): { readonly publishedAt?: string } {
  return typeof value === "string" && value ? { publishedAt: value } : {}
}

function string(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []
}
