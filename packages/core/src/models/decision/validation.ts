import { assertJsonValue, cloneJsonValue } from "../../json"
import { UnsupportedModelFeatureError } from "../errors"
import type {
  ChoiceQuestion,
  DecisionAnswers,
  DecisionContent,
  DecisionModel,
  DecisionModelDefinition,
  DecisionQuestion,
  DecisionQuestions,
  ScoreQuestion,
} from "./types"

type DecisionCapabilities = DecisionModelDefinition["capabilities"]

// Allow serialization rounding without normalizing provider answers.
const DISTRIBUTION_TOLERANCE = 1e-4
const CHOICE_TOLERANCE = 1e-6

export function assertDecisionContent(
  value: unknown,
  path: string
): asserts value is DecisionContent {
  assertJsonValue(value, path)
  if (value === null || (typeof value !== "string" && typeof value !== "object")) {
    throw new TypeError(`[SixbModels] ${path} must be text, a JSON object or an array.`)
  }
}

export function assertDecisionQuestions(value: unknown): asserts value is DecisionQuestions {
  assertJsonValue(value, "questions")
  const questions = readRecord(value, "questions")
  if (!Object.keys(questions).length) {
    fail("questions must not be empty")
  }

  for (const [key, question] of Object.entries(questions)) {
    if (!key.trim()) {
      fail("question names must not be empty")
    }
    assertQuestion(question, `questions.${key}`)
  }
}

function assertQuestion(value: unknown, path: string): void {
  const question = readRecord(value, path)
  assertDecisionContent(question.instructions, `${path}.instructions`)
  if (typeof question.instructions === "string" && !question.instructions.trim()) {
    fail(`${path}.instructions must not be empty`)
  }

  switch (question.type) {
    case "choice":
      assertOnlyKeys(question, ["type", "instructions", "options"], path)
      assertChoiceOptions(question.options, `${path}.options`)
      break
    case "score":
      assertOnlyKeys(question, ["type", "instructions", "levels"], path)
      assertScoreLevels(question.levels, `${path}.levels`)
      break
    case "probability":
      assertOnlyKeys(question, ["type", "instructions"], path)
      break
    default:
      fail(`${path}.type is not a supported decision primitive`)
  }
}

function assertChoiceOptions(value: unknown, path: string): void {
  const options = readRecord(value, path)
  if (!Object.keys(options).length) {
    fail(`${path} must not be empty`)
  }

  for (const [option, description] of Object.entries(options)) {
    if (!option.trim()) {
      fail(`${path} contains an empty label`)
    }
    if (description !== null) {
      assertDecisionContent(description, `${path}.${option}`)
    }
  }
}

function assertScoreLevels(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length < 2) {
    fail(`${path} needs at least two levels`)
  }

  for (const level of value) {
    assertDecisionContent(level, path)
  }
}

export function assertDecisionModel(model: DecisionModel): void {
  const definition = model?.definition
  if (
    !model ||
    typeof model.evaluate !== "function" ||
    !isValidId(model.providerId) ||
    !isValidId(model.modelId) ||
    definition?.kind !== "decision" ||
    definition.providerId !== model.providerId ||
    definition.modelId !== model.modelId
  ) {
    fail("Expected a DecisionModel with matching provider/model identity")
  }

  const capabilities = definition.capabilities
  if (
    !capabilities ||
    !Array.isArray(capabilities.questions) ||
    !capabilities.questions.length ||
    capabilities.questions.some((kind) => !["choice", "score", "probability"].includes(kind)) ||
    new Set(capabilities.questions).size !== capabilities.questions.length
  ) {
    fail("Decision model capabilities must list distinct supported question types")
  }

  assertCapabilityLimit(capabilities.maxChoices, "maxChoices", 1)
  assertCapabilityLimit(capabilities.maxScoreLevels, "maxScoreLevels", 2)
}

function assertCapabilityLimit(value: number | undefined, name: string, minimum: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
    fail(`Invalid decision capability '${name}'`)
  }
}

export function assertDecisionSupport(model: DecisionModel, questions: DecisionQuestions): void {
  for (const [key, question] of Object.entries(questions)) {
    if (!supportsQuestion(model.definition.capabilities, question)) {
      throw new UnsupportedModelFeatureError(
        `[SixbModels] Model '${model.providerId}/${model.modelId}' does not support questions.${key}.`
      )
    }
  }
}

function supportsQuestion(capabilities: DecisionCapabilities, question: DecisionQuestion): boolean {
  if (!capabilities.questions.includes(question.type)) return false

  switch (question.type) {
    case "choice":
      return Object.keys(question.options).length <= (capabilities.maxChoices ?? Infinity)
    case "score":
      return question.levels.length <= (capabilities.maxScoreLevels ?? Infinity)
    case "probability":
      return true
  }
}

export function validateDecisionAnswers<const Q extends DecisionQuestions>(
  questions: Q,
  value: unknown
): DecisionAnswers<Q> {
  assertJsonValue(value, "decision output")
  const answers = readRecord(value, "decision output")
  assertExactKeys(answers, Object.keys(questions), "decision output")

  for (const [key, question] of Object.entries(questions)) {
    assertAnswer(question, answers[key], `output.${key}`)
  }

  // Validation establishes the mapped type; callers receive an independent JSON snapshot.
  return cloneJsonValue(value) as DecisionAnswers<Q>
}

function assertAnswer(question: DecisionQuestion, value: unknown, path: string): void {
  const answer = readRecord(value, path)
  if (question.type === "probability") {
    assertExactKeys(answer, ["probability"], path)
    readProbability(answer.probability, path)
    return
  }

  assertOnlyKeys(answer, [question.type, "probabilities", "confidence"], path)
  if (answer.confidence !== undefined) {
    readProbability(answer.confidence, `${path}.confidence`)
  }

  const distribution =
    question.type === "choice"
      ? validateChoiceAnswer(question, answer, path)
      : validateScoreAnswer(question, answer, path)

  const total = distribution.reduce((sum, probability) => sum + probability, 0)
  if (Math.abs(total - 1) > DISTRIBUTION_TOLERANCE) {
    fail(`${path}.probabilities must sum to one`)
  }
}

function validateChoiceAnswer(
  question: ChoiceQuestion,
  answer: Record<string, unknown>,
  path: string
): number[] {
  const probabilities = readRecord(answer.probabilities, `${path}.probabilities`)
  assertExactKeys(probabilities, Object.keys(question.options), `${path}.probabilities`)
  const distribution = Object.values(probabilities).map((value) => readProbability(value, path))

  if (typeof answer.choice !== "string" || !Object.hasOwn(question.options, answer.choice)) {
    fail(`${path}.choice is not a declared option`)
  }

  const winner = readProbability(probabilities[answer.choice], path)
  if (winner + CHOICE_TOLERANCE < Math.max(...distribution)) {
    fail(`${path}.choice is not a highest-probability option`)
  }

  return distribution
}

function validateScoreAnswer(
  question: ScoreQuestion,
  answer: Record<string, unknown>,
  path: string
): number[] {
  if (
    !Array.isArray(answer.probabilities) ||
    answer.probabilities.length !== question.levels.length
  ) {
    fail(`${path}.probabilities must match the score levels`)
  }

  const distribution = answer.probabilities.map((value) => readProbability(value, path))
  const expected = distribution.reduce((sum, probability, index) => sum + probability * index, 0)
  const tolerance = DISTRIBUTION_TOLERANCE * question.levels.length
  if (
    typeof answer.score !== "number" ||
    !Number.isFinite(answer.score) ||
    answer.score < 0 ||
    answer.score > question.levels.length - 1 ||
    Math.abs(answer.score - expected) > tolerance
  ) {
    fail(`${path}.score is inconsistent with its distribution`)
  }

  return distribution
}

function readProbability(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${path} must contain probabilities between zero and one`)
  }
  return value
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string
): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    fail(`${path} contains an unknown field`)
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string
): void {
  assertOnlyKeys(value, keys, path)
  if (keys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${path} is missing an expected field`)
  }
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.trim() === value
}

function fail(detail: string): never {
  throw new TypeError(`[SixbModels] ${detail}.`)
}
