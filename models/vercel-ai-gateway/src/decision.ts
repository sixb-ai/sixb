import {
  type DecisionAnswer,
  type DecisionModel,
  type DecisionModelDefinition,
  type DecisionModelRequest,
  DecisionModelResponseError,
  type DecisionModelResponseMetadata,
  type DecisionModelResult,
  type DecisionQuestion,
  type DecisionQuestions,
  type JsonObject,
  type ModelCostEstimator,
} from "@sixb/core/models"

export interface VercelGatewayDecisionOptions {
  /** Gateway routing and provider-specific options for /evaluate. */
  readonly providerOptions?: JsonObject
  /** Per-inference timeout, including response body consumption. Defaults to 30 seconds. */
  readonly timeoutMs?: number
}

export interface GatewayDecisionResolution {
  readonly definition?: DecisionModelDefinition
  readonly estimator: ModelCostEstimator
}

/** Transport and pricing remain owned by the configured Gateway instance. */
export function createGatewayDecision(
  modelId: string,
  request: (input: DecisionModelRequest) => Promise<{
    body: unknown
    metadata: DecisionModelResponseMetadata
  }>,
  resolve?: () => Promise<GatewayDecisionResolution>,
  resolved?: GatewayDecisionResolution
): DecisionModel {
  if (typeof modelId !== "string" || !modelId.trim() || modelId.trim() !== modelId) {
    throw new TypeError("[SixbVercelGateway] Decision model id must be a nonempty trimmed string.")
  }
  return Object.freeze({
    providerId: "vercel-ai-gateway",
    modelId,
    definition: resolved?.definition ?? gatewayDecisionDefinition(modelId),
    costEstimator: resolved?.estimator,
    ...(resolve
      ? { resolve: async () => createGatewayDecision(modelId, request, undefined, await resolve()) }
      : {}),
    async evaluate(input: DecisionModelRequest) {
      input.signal?.throwIfAborted()
      const { body, metadata } = await request(input)
      return decisionResponse(body, input.questions, modelId, metadata)
    },
  })
}

export function gatewayDecisionDefinition(
  modelId: string,
  details: { name?: string; description?: string } = {}
): DecisionModelDefinition {
  return Object.freeze({
    kind: "decision",
    providerId: "vercel-ai-gateway",
    modelId,
    ...details,
    ...(modelId === "typesafe-ai/jev"
      ? { publisher: Object.freeze({ id: "typesafe-ai", name: "TypeSafe AI" }) }
      : {}),
    via: "Vercel AI Gateway",
    capabilities: Object.freeze({
      questions: Object.freeze(["choice", "score", "probability"] as const),
      // Observed on the Jev Gateway route: scores and probabilities round independently.
      ...(modelId === "typesafe-ai/jev"
        ? { answerDecimalPlaces: 2, maxChoices: 255, maxScoreLevels: 10 }
        : {}),
    }),
  })
}

export function gatewayDecisionQuestions(questions: DecisionQuestions) {
  // Object.fromEntries keeps caller-selected names such as __proto__ as data.
  return Object.fromEntries(
    Object.entries(questions).map(([key, question]) => [key, gatewayQuestion(question)])
  )
}

function gatewayQuestion(question: DecisionQuestion) {
  const { instructions } = question
  switch (question.type) {
    case "choice":
      return { type: "choice", instructions, criteria: question.options }
    case "score":
      return { type: "score", instructions, criteria: question.levels }
    case "probability":
      return { type: "boolean", instructions }
  }
}

function decisionResponse(
  body: unknown,
  questions: DecisionQuestions,
  modelId: string,
  metadata: DecisionModelResponseMetadata
): DecisionModelResult {
  try {
    const payload = record(body)
    if (typeof payload.model !== "string" || !payload.model.trim()) {
      throw new Error("Missing response model")
    }
    const answers = record(payload.answers)
    assertKeys(answers, Object.keys(questions))
    const output = Object.fromEntries(
      Object.entries(questions).map(
        ([key, question]): [string, DecisionAnswer<DecisionQuestion>] => {
          const answer = record(answers[key])
          if (answer.type !== (question.type === "probability" ? "boolean" : question.type)) {
            throw new Error("Unexpected answer type")
          }
          if (question.type === "probability") {
            return [key, { probability: finite(answer.probability) }]
          }
          const confidence =
            answer.confidence === undefined ? {} : { confidence: finite(answer.confidence) }
          const probabilities = record(answer.probabilities)
          if (question.type === "choice") {
            if (typeof answer.choice !== "string") throw new Error("Missing choice")
            assertKeys(probabilities, Object.keys(question.options))
            return [
              key,
              {
                choice: answer.choice,
                probabilities: Object.fromEntries(
                  Object.entries(probabilities).map(([label, value]) => [label, finite(value)])
                ),
                ...confidence,
              },
            ]
          }
          const indexes = question.levels.map((_, index) => String(index))
          assertKeys(probabilities, indexes)
          return [
            key,
            {
              score: finite(answer.score),
              probabilities: indexes.map((index) => finite(probabilities[index])),
              ...confidence,
            },
          ]
        }
      )
    )
    // Sixb validates distributions, winning labels, expected scores and probability bounds.
    return { ...metadata, output }
  } catch (cause) {
    throw new DecisionModelResponseError(
      "[SixbVercelGateway] Invalid decision response.",
      "vercel-ai-gateway",
      modelId,
      metadata,
      { cause }
    )
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object")
  }
  return value as Record<string, unknown>
}

function assertKeys(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("Mismatched decision response keys")
  }
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Expected a finite number")
  }
  return value
}
