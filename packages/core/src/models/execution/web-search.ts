import { randomUUID } from "node:crypto"
import type { WebSearchModelCatalog } from "../catalog"
import { indexModelBindings } from "../catalog-index"
import { estimateModelCall, type ModelMoney } from "../pricing"
import {
  assertWebSearchModel,
  MAX_WEB_SEARCH_RESULTS,
  validateWebSearchHits,
  type WebSearchModel,
  type WebSearchModelRequest,
  WebSearchModelResponseError,
  type WebSearchModelResponseMetadata,
  type WebSearchModelResult,
} from "../web-search-model"
import type { AiModelCallRecorder } from "./model-call-recorder"
import type { ModelExecutionSession } from "./session"

/** What a search needs of an execution: its cancellation and its accounting. */
export type WebSearchExecution = Pick<ModelExecutionSession, "signal" | "accounting">

/** Scope the catalog's searches to one execution: each is admitted, bounded and recorded. */
export function bindWebSearchModels(
  catalog: WebSearchModelCatalog | undefined,
  session: WebSearchExecution
): WebSearchModelCatalog | undefined {
  if (!catalog) return undefined

  const index = indexModelBindings(
    catalog.list().map(({ model }) =>
      Object.freeze({
        providerId: model.providerId,
        modelId: model.modelId,
        definition: model.definition,
        search: (input: WebSearchModelRequest) => executeWebSearch(session, model, input),
      })
    ),
    "webSearch",
    assertWebSearchModel
  )

  const defaultEntry = index.getByRef(catalog.default)
  if (!defaultEntry) throw new Error("[SixbModels] The default web search model is not listed.")

  return Object.freeze({ ...index, default: defaultEntry })
}

async function executeWebSearch(
  session: WebSearchExecution,
  binding: WebSearchModel,
  input: WebSearchModelRequest
): Promise<WebSearchModelResult> {
  const request = prepareRequest(input)
  const signal = AbortSignal.any([session.signal(input.signal), AbortSignal.timeout(30_000)])
  signal.throwIfAborted()

  const accounting = await session.accounting()
  accounting.assertHealthy()
  const model = (await binding.resolve?.()) ?? binding
  assertWebSearchModel(model)
  if (model.providerId !== binding.providerId || model.modelId !== binding.modelId) {
    throw new TypeError(
      "[SixbModels] Resolved web search model identity does not match its binding."
    )
  }
  signal.throwIfAborted()

  const callId = `call_${randomUUID()}`
  await accounting.admitCall({
    callId,
    providerId: model.providerId,
    modelId: model.modelId,
    modelKind: "web-search",
    inputTokens: {
      status: "estimated",
      tokens: Math.ceil(new TextEncoder().encode(request.query).byteLength / 4),
      method: "utf8BytesDividedByFour",
    },
    outputTokenAllowance: 0,
    reservationCost: estimateReservationCost(model, request.maxResults),
  })

  let result: WebSearchModelResult
  try {
    signal.throwIfAborted()
    result = await model.search({ ...request, signal })
  } catch (error) {
    // A reply Sixb could not read is recorded with what it cost. Without a reply, whether the
    // provider charged is unknown: recording it unpriced would leave a cost limit unable to count
    // until its period ends, so the reservation is kept instead, as for a language call.
    if (error instanceof WebSearchModelResponseError) {
      await recordWebSearch(accounting, model, callId, error.metadata)
    } else {
      await accounting.markCallUnknown(callId)
    }
    throw error
  }

  // A completed, billable reply must survive cancellation and result validation failures.
  await recordWebSearch(accounting, model, callId, result ?? {})
  signal.throwIfAborted()

  try {
    return { ...result, results: validateWebSearchHits(result?.results, request.maxResults) }
  } catch (cause) {
    throw new WebSearchModelResponseError(
      "[SixbModels] Invalid web search response.",
      model.providerId,
      model.modelId,
      result ?? {},
      { cause }
    )
  }
}

/** Snapshot the caller's request before the first await. */
function prepareRequest(input: WebSearchModelRequest): Omit<WebSearchModelRequest, "signal"> {
  const query = input?.query
  if (typeof query !== "string" || !query.trim()) {
    throw new TypeError("[SixbModels] Web search requires a nonempty query.")
  }

  const maxResults = input.maxResults
  if (typeof maxResults !== "number" || !Number.isSafeInteger(maxResults)) {
    throw new TypeError("[SixbModels] Web search maxResults must be an integer.")
  }

  const allowedDomains = domains(input.allowedDomains, "allowedDomains")
  const blockedDomains = domains(input.blockedDomains, "blockedDomains")

  return {
    query: query.trim(),
    maxResults: Math.min(Math.max(maxResults, 1), MAX_WEB_SEARCH_RESULTS),
    ...(allowedDomains === undefined ? {} : { allowedDomains }),
    ...(blockedDomains === undefined ? {} : { blockedDomains }),
  }
}

function domains(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new TypeError(`[SixbModels] Web search ${field} must contain nonempty strings.`)
  }

  return Object.freeze([...value])
}

function estimateReservationCost(
  model: WebSearchModel,
  maxResults: number
): ModelMoney | undefined {
  try {
    return model.costEstimator?.estimateReservation?.({ maxResults })
  } catch {
    // Optional pricing cannot bypass an enforced budget: admission fails closed without it.
    return undefined
  }
}

async function recordWebSearch(
  accounting: AiModelCallRecorder,
  model: WebSearchModel,
  callId: string,
  metadata: WebSearchModelResponseMetadata
): Promise<void> {
  const usage = metadata.usage ?? {}
  const estimate = estimateModelCall(model, {
    usage,
    route: metadata.route,
    responseModelId: metadata.responseModelId,
  })

  await accounting.onModelCallEnd({
    callId,
    modelKind: "web-search",
    providerId: model.providerId,
    modelId: model.modelId,
    responseId: metadata.providerIds?.responseId ?? callId,
    responseModelId: metadata.responseModelId,
    providerIds: metadata.providerIds,
    usage,
    cost: metadata.reportedCost ? { status: "reported", ...metadata.reportedCost } : estimate,
    ...(metadata.reportedCost ? { estimate } : {}),
    route: metadata.route,
  })
}
