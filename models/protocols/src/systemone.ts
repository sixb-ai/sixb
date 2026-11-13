import {
  type ChoiceQuestion,
  type DecisionAnswer,
  type DecisionModelRequest,
  DecisionModelResponseError,
  type DecisionModelResponseMetadata,
  type DecisionModelResult,
  type DecisionQuestion,
  type DecisionQuestions,
  type ProbabilityQuestion,
  type ScoreQuestion,
} from "@sixb/core/models"

/** How a provider reads a System One response; the protocol itself carries no identity rules. */
export interface SystemOneResponseOptions {
  readonly providerId: string
  readonly modelId: string
  /** Opens the error message, such as `[SixbTypeSafe]`. */
  readonly errorPrefix: string
  /** Kept as `providerIds.requestId`; the provider redacts it before passing it. */
  readonly requestId?: string
  /** Throws to reject the response's `model` field; answers then fail, usage is kept. */
  readonly assertModel?: (model: unknown) => void
  /** Applied to provider text kept in metadata, such as the response model. */
  readonly redact?: (value: string) => string
}

/** The body of `POST /systemone`. Probability questions are `noul` on the wire. */
export function systemOneRequest(
  model: string,
  { input, questions }: Pick<DecisionModelRequest, "input" | "questions">
) {
  return {
    model,
    state: input,
    // Keep user-selected keys as data, including __proto__ and constructor.
    questions: Object.fromEntries(
      Object.entries(questions).map(([key, question]) => [key, wireQuestion(question)])
    ),
  }
}

function wireQuestion(question: DecisionQuestion) {
  const { instructions } = question
  switch (question.type) {
    case "choice":
      return { type: "choice", instructions, criteria: question.options }
    case "score":
      return { type: "score", instructions, criteria: question.levels }
    case "probability":
      return { type: "noul", instructions }
  }
}

/**
 * Decode answers and billing evidence. A malformed answer throws a `DecisionModelResponseError`
 * that still carries the usage, so the runtime can record a billable call.
 */
export function systemOneResult(
  body: unknown,
  questions: DecisionQuestions,
  options: SystemOneResponseOptions
): DecisionModelResult {
  // Read billing evidence first; malformed answers must not discard it.
  const metadata = readMetadata(body, options)

  try {
    const payload = record(body, "response")
    options.assertModel?.(payload.model)

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
      `${options.errorPrefix} Invalid decision response.`,
      options.providerId,
      options.modelId,
      metadata,
      { cause }
    )
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

/** Score probabilities arrive keyed by level index ("0", "1", …), beside a `legend`. */
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

function readMetadata(
  body: unknown,
  options: SystemOneResponseOptions
): DecisionModelResponseMetadata {
  const payload = isRecord(body) ? body : {}
  const rawUsage = isRecord(payload.usage) ? payload.usage : {}
  const inputTokens = counter(rawUsage.input_tokens)
  const outputTokens = counter(rawUsage.output_tokens)
  const model = typeof payload.model === "string" && payload.model.trim() ? payload.model : ""

  // Missing or invalid counters remain unknown; keep independent valid counters.
  return {
    usage: {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
    },
    ...(model ? { responseModelId: options.redact ? options.redact(model) : model } : {}),
    ...(options.requestId ? { providerIds: { requestId: options.requestId } } : {}),
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
