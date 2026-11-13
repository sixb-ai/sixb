import {
  type JsonObject,
  ModelProviderError,
  type ModelUsage,
  UnsupportedModelFeatureError,
  type WebSearchCostEstimator,
  type WebSearchHit,
  type WebSearchModel,
  type WebSearchModelDefinition,
  type WebSearchModelRequest,
  WebSearchModelResponseError,
  type WebSearchModelResponseMetadata,
  type WebSearchModelResult,
} from "@sixb/core/models"
import { responsesUsage } from "@sixb/model-protocols/responses"
import { deploymentMetadata, type FoundryDeployments, type ResolvedDeployment } from "./discovery"
import { assertDeploymentKind } from "./kinds"
import type { AzureAIFoundryModelMetadata } from "./provider"
import { azurePublisher } from "./publisher"
import { abortable, type FoundryTransport, readJson, requestId } from "./transport"
import { object, PREFIX, positiveInteger } from "./util"

/** The efforts Azure runs web search at: none and minimal return no results. */
export type WebSearchReasoning = "low" | "medium" | "high" | "xhigh"
const REASONING: readonly WebSearchReasoning[] = ["low", "medium", "high", "xhigh"]

export interface AzureAIFoundryWebSearchOptions {
  /**
   * The reasoning effort of the deployment that runs the search. Default: `low`. Azure returns
   * the search's results only to reasoning models.
   */
  readonly reasoning?: WebSearchReasoning
  /** Deadline for one search, response included. Default: 30,000 ms, as Sixb's runtime. */
  readonly timeoutMs?: number
  /** Prices the search fee and the deployment's tokens; Azure reports no search count. */
  readonly costEstimator?: WebSearchCostEstimator
}

export interface AzureAIFoundryWebSearchModel extends WebSearchModel {
  readonly metadata: AzureAIFoundryModelMetadata
  resolve(options?: { readonly offline?: boolean }): Promise<AzureAIFoundryWebSearchModel>
}

/** Eleven hits and the deployment's short answer; the reply never holds page contents. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Azure's allowed-domain list holds at most 100 entries. */
const MAX_DOMAINS = 100

/** AbortSignal.timeout's largest delay. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

const INSTRUCTIONS =
  "Run exactly one web search for the user's query, as written. Then reply with the single word: done."

interface WebSearchSettings {
  readonly reasoning: WebSearchReasoning
  readonly timeoutMs: number
  readonly costEstimator?: WebSearchCostEstimator
}

export function createFoundryWebSearch(
  providerId: string,
  modelId: string,
  options: AzureAIFoundryWebSearchOptions,
  transport: FoundryTransport,
  deployments: FoundryDeployments
): AzureAIFoundryWebSearchModel {
  if (!modelId.trim() || modelId !== modelId.trim())
    throw new TypeError(`${PREFIX} deploymentName must be nonempty without surrounding whitespace.`)
  positiveInteger(options.timeoutMs, "timeoutMs")
  if (options.timeoutMs !== undefined && options.timeoutMs > MAX_TIMEOUT_MS)
    throw new TypeError(`${PREFIX} timeoutMs must be at most ${MAX_TIMEOUT_MS}.`)
  if (options.reasoning !== undefined && !REASONING.includes(options.reasoning))
    throw new TypeError(`${PREFIX} reasoning must be one of ${REASONING.join(", ")}.`)
  // Validate and snapshot now: later edits to the caller's object change nothing.
  const settings: WebSearchSettings = Object.freeze({
    reasoning: options.reasoning ?? "low",
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.costEstimator ? { costEstimator: options.costEstimator } : {}),
  })
  return webSearchBinding(providerId, modelId, settings, transport, deployments)
}

/**
 * Discovery confirms a language deployment; each search asks it for one call of the Responses
 * API's `web_search` tool and reads the hits from that call, never from the model's prose.
 */
function webSearchBinding(
  providerId: string,
  modelId: string,
  settings: WebSearchSettings,
  transport: FoundryTransport,
  deployments: FoundryDeployments,
  resolution?: ResolvedDeployment
): AzureAIFoundryWebSearchModel {
  const deployment = resolution?.deployment
  const definition: WebSearchModelDefinition = Object.freeze({
    kind: "web-search",
    providerId,
    modelId,
    ...(deployment ? { publisher: azurePublisher(deployment.modelPublisher) } : {}),
    via: "Azure AI Foundry",
  })

  let pending: Promise<AzureAIFoundryWebSearchModel> | undefined
  const binding: AzureAIFoundryWebSearchModel = Object.freeze({
    providerId,
    modelId,
    definition,
    metadata: deploymentMetadata(resolution),
    ...(resolution && settings.costEstimator ? { costEstimator: settings.costEstimator } : {}),

    async resolve(input?: { readonly offline?: boolean }) {
      if (resolution) return binding
      const resolved = await deployments.resolve(modelId, input?.offline === true)
      assertDeploymentKind(resolved.deployment, modelId, "language")
      // The tool runs on Azure OpenAI's models, and returns results only to those that reason.
      if (
        resolved.deployment.modelPublisher.toLowerCase() !== "openai" ||
        /^(gpt-4|gpt-5(\.\d+)?-chat)/i.test(resolved.deployment.modelName)
      )
        throw new UnsupportedModelFeatureError(
          `${PREFIX} Deployment '${modelId}' runs ${resolved.deployment.modelName}; web search needs an OpenAI reasoning model, such as gpt-5.4-nano.`
        )
      return webSearchBinding(providerId, modelId, settings, transport, deployments, resolved)
    },

    async search(request: WebSearchModelRequest): Promise<WebSearchModelResult> {
      const signal = AbortSignal.any([
        ...(request.signal ? [request.signal] : []),
        AbortSignal.timeout(settings.timeoutMs),
      ])
      signal.throwIfAborted()
      if (typeof request.query !== "string" || !request.query.trim())
        throw new TypeError(`${PREFIX} Web search requires a nonblank query.`)
      const maxResults = Math.min(Math.max(Math.trunc(request.maxResults) || 1, 1), 10)
      const allowed = domains(request.allowedDomains, "allow")
      const blocked = domains(request.blockedDomains, "block")
      if (!resolution) {
        // A direct call pins the deployment once, as the runtime does before admission.
        pending ??= binding.resolve().catch((error) => {
          pending = undefined
          throw error
        })
        const resolved = await abortable(() => pending!, signal)
        return resolved.search({ ...request, signal })
      }

      const response = await transport.post(
        JSON.stringify({
          model: modelId,
          instructions: INSTRUCTIONS,
          input: request.query,
          tools: [
            {
              type: "web_search",
              ...(allowed || blocked
                ? {
                    filters: {
                      ...(allowed ? { allowed_domains: allowed } : {}),
                      ...(blocked ? { blocked_domains: blocked } : {}),
                    },
                  }
                : {}),
            },
          ],
          tool_choice: "required",
          max_tool_calls: 1,
          // The search's own results, which Azure returns to reasoning models only.
          include: ["web_search_call.results"],
          reasoning: { effort: settings.reasoning },
          store: false,
        }),
        signal,
        providerId,
        modelId,
        "web-search"
      )
      const id = transport.redactText(response, requestId(response))
      let body: unknown
      try {
        body = await readJson(response, signal, MAX_RESPONSE_BYTES)
      } catch {
        if (signal.aborted) throw signal.reason
        throw new ModelProviderError(
          `${PREFIX} Web search returned invalid JSON.`,
          providerId,
          modelId,
          { code: "invalid_json", requestId: id, status: response.status }
        )
      }
      const payload = object(body)
      const responseId = typeof payload?.id === "string" && payload.id ? payload.id : undefined
      const metadata: WebSearchModelResponseMetadata = {
        usage: searchUsage(payload),
        ...(typeof payload?.model === "string" ? { responseModelId: payload.model } : {}),
        ...(id || responseId
          ? {
              providerIds: {
                ...(id ? { requestId: id } : {}),
                ...(responseId ? { responseId } : {}),
              },
            }
          : {}),
      }
      const output = Array.isArray(payload?.output) ? payload.output : undefined
      const calls = (output ?? []).map(object).filter((item) => item?.type === "web_search_call")
      const failure = (reason: string) =>
        new WebSearchModelResponseError(`${PREFIX} ${reason}`, providerId, modelId, metadata)
      if (!calls.length || payload?.status === "failed")
        throw failure("The deployment ran no web search.")
      if (!calls.some((call) => Array.isArray(call?.results)))
        throw failure("The search returned no results list: use a model with reasoning.")
      return { ...metadata, results: searchHits(calls).slice(0, maxResults) }
    },
  })
  return binding
}

/**
 * Azure filters by bare hostname, subdomains included; Sixb's rules can also name subdomains only
 * (`*.example.com`) or a path (`example.com/docs`), and Sixb filters the hits again. An allowed
 * rule widens to its host, which Sixb narrows back; a blocked one is sent only when it is a bare
 * host, since its host would block more than the rule does.
 */
function domains(
  list: readonly string[] | undefined,
  mode: "allow" | "block"
): string[] | undefined {
  const hosts = new Set<string>()
  for (const rule of list ?? []) {
    const bare = rule
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
    const host = bare.replace(/^\*\./, "").replace(/[/?#].*$/, "")
    if (!host || (mode === "block" && host !== bare.replace(/\/$/, ""))) continue
    hosts.add(host)
  }
  return hosts.size ? [...hosts].slice(0, MAX_DOMAINS) : undefined
}

/** Each result once, in the order the search returned them. */
function searchHits(calls: readonly (JsonObject | undefined)[]): WebSearchHit[] {
  const hits: WebSearchHit[] = []
  const seen = new Set<string>()
  for (const call of calls) {
    for (const raw of Array.isArray(call?.results) ? call.results : []) {
      const result = object(raw)
      if (typeof result?.url !== "string" || seen.has(result.url)) continue
      seen.add(result.url)
      hits.push({
        url: result.url,
        title: typeof result.title === "string" ? result.title : "",
        snippet: typeof result.snippet === "string" ? result.snippet : "",
      })
    }
  }
  return hits
}

/** The deployment's tokens; the search fee Azure bills is not reported. */
function searchUsage(payload: JsonObject | undefined): ModelUsage {
  return responsesUsage(object(payload?.usage))
}
