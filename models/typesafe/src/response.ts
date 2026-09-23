import {
  type ChoiceQuestion,
  type DecisionAnswer,
  DecisionModelResponseError,
  type DecisionModelResponseMetadata,
  type DecisionModelResult,
  type DecisionQuestion,
  type DecisionQuestions,
  type ProbabilityQuestion,
  type ScoreQuestion,
} from "@sixb/core/models"

export function typesafeResponse(
  body: unknown,
  questions: DecisionQuestions,
  modelId: string,
  requestId?: string
): DecisionModelResult {
  // Read billing evidence first; malformed answers must not discard it.
  const metadata = readMetadata(body, requestId)

  try {
    const payload = record(body, "response")
    assertResponseModel(payload.model, modelId)

    const answers = record(payload.answers, "answers")
    assertKeys(answers, Object.keys(questions), "answer keys")
    const output = Object.fromEntries(
      Object.entries(questions).map(
        ([key, question]) => [key, readAnswer(answers[key], question, key)] as const
      )
    )

    // Sixb validates distributions, winning labels and expected scores.
    return { ...metadata, output }
  } catch (cause) {
    throw new DecisionModelResponseError(
      "[SixbTypeSafe] Invalid decision response.",
      "typesafe",
      modelId,
      metadata,
      { cause }
    )
  }
}

function assertResponseModel(value: unknown, requestedModel: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Missing response model")
  }
  if (/^jev-\d+\.\d+\.\d+$/.test(requestedModel) && value !== requestedModel) {
    throw new Error("Pinned model identity changed")
  }
}

function readAnswer(
  value: unknown,
  question: DecisionQuestion,
  key: string
): DecisionAnswer<DecisionQuestion> {
  const answer = record(value, `answers.${key}`)
  const wireType = question.type === "probability" ? "noul" : question.type
  if (answer.type !== wireType) {
    throw new Error(`Unexpected answer type for '${key}'`)
  }

  switch (question.type) {
    case "choice":
      return readChoiceAnswer(answer)
    case "score":
      return readScoreAnswer(answer, question)
    case "probability":
      return readProbabilityAnswer(answer)
  }
}

function readChoiceAnswer(answer: Record<string, unknown>): DecisionAnswer<ChoiceQuestion> {
  if (typeof answer.choice !== "string") throw new Error("Missing choice")

  const probabilities = record(answer.probabilities, "choice probabilities")
  return {
    choice: answer.choice,
    confidence: finite(answer.confidence),
    probabilities: Object.fromEntries(
      Object.entries(probabilities).map(([label, value]) => [label, finite(value)])
    ),
  }
}

function readScoreAnswer(
  answer: Record<string, unknown>,
  question: ScoreQuestion
): DecisionAnswer<ScoreQuestion> {
  const probabilities = record(answer.probabilities, "score probabilities")
  const indexes = question.levels.map((_, index) => String(index))
  assertKeys(probabilities, indexes, "score levels")

  return {
    score: finite(answer.score),
    confidence: finite(answer.confidence),
    probabilities: indexes.map((index) => finite(probabilities[index])),
  }
}

function readProbabilityAnswer(
  answer: Record<string, unknown>
): DecisionAnswer<ProbabilityQuestion> {
  return { probability: finite(answer.noul) }
}

function readMetadata(body: unknown, requestId?: string): DecisionModelResponseMetadata {
  const payload = isRecord(body) ? body : {}
  const rawUsage = isRecord(payload.usage) ? payload.usage : {}
  const inputTokens = counter(rawUsage.input_tokens)
  const outputTokens = counter(rawUsage.output_tokens)

  // Missing or invalid counters remain unknown; keep independent valid counters.
  return {
    usage: {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
    },
    ...(typeof payload.model === "string" && payload.model.trim()
      ? { responseModelId: payload.model }
      : {}),
    ...(requestId ? { providerIds: { requestId } } : {}),
  }
}

function assertKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`Mismatched ${label}`)
  }
}

function counter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Expected a finite number")
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${label}`)
  return value
}
