import {
  type DecisionModel,
  estimateModelReservation,
  type LanguageModelRateCard,
  rateModelCall,
} from "@sixb/core/models"
import { evaluateTypesafe, type TypesafeTransport } from "./transport"

const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1"

// Published retail estimate, verified 2026-09-22: https://docs.typesafe.ai/models
const RATE_CARD: LanguageModelRateCard = {
  currency: "USD",
  unit: "million-tokens",
  input: "0.042",
  output: "0",
}

export interface TypesafeOptions {
  readonly apiKey?: string | (() => string | undefined)
  /** Base including /v1. Override for an explicitly configured compatible endpoint. */
  readonly baseUrl?: string
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly timeoutMs?: number
}

export type TypesafeProvider = (modelId: string) => DecisionModel

/** No hidden inference retries. Each evaluate() makes at most one HTTP request. */
export function createTypesafe(options: TypesafeOptions = {}): TypesafeProvider {
  const transport = resolveTransport(options)
  return (modelId) => createModel(modelId, transport)
}

function createModel(modelId: string, transport: TypesafeTransport): DecisionModel {
  if (typeof modelId !== "string" || !modelId.trim() || modelId.trim() !== modelId) {
    throw new TypeError("[SixbTypeSafe] modelId must be a nonempty trimmed string.")
  }

  const model: DecisionModel = {
    providerId: "typesafe",
    modelId,
    definition: Object.freeze({
      kind: "decision",
      providerId: "typesafe",
      modelId,
      publisher: Object.freeze({ id: "typesafe", name: "TypeSafe" }),
      capabilities: Object.freeze({
        questions: Object.freeze(["choice", "score", "probability"] as const),
        maxChoices: 255,
        maxScoreLevels: 10,
      }),
    }),
    costEstimator: {
      estimateReservation: (input) =>
        estimateModelReservation({
          ...input,
          rateCard: rateCardFor(transport.endpoint, modelId),
        }),
      estimate: ({ usage, responseModelId }) =>
        rateModelCall({
          usage,
          rateCard: rateCardFor(transport.endpoint, responseModelId ?? modelId),
        }),
    },
    evaluate: (request) => evaluateTypesafe(transport, modelId, request),
  }

  return Object.freeze(model)
}

function resolveTransport(options: TypesafeOptions): TypesafeTransport {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  const url = new URL(baseUrl)
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      "[SixbTypeSafe] baseUrl must be an HTTP(S) URL without credentials, query or fragment."
    )
  }

  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("[SixbTypeSafe] timeoutMs must be a positive safe integer.")
  }

  return {
    endpoint: `${baseUrl.replace(/\/$/, "")}/systemone`,
    timeoutMs,
    fetch: options.fetch ?? globalThis.fetch,
    // Resolve credentials for each call so environment/getter rotation remains effective.
    apiKey: () =>
      typeof options.apiKey === "function"
        ? options.apiKey()
        : (options.apiKey ?? process.env.TYPESAFE_API_KEY),
  }
}

function rateCardFor(endpoint: string, modelId: string | undefined) {
  return endpoint === `${DEFAULT_BASE_URL}/systemone` && modelId === "jev-1.13.0"
    ? RATE_CARD
    : undefined
}

export const typesafe: TypesafeProvider = createTypesafe()
