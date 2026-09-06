import {
  MODEL_REASONING_EFFORTS,
  type ModelCapabilities,
  type ModelReasoningBudgetCapabilities,
  type ModelReasoningCapabilities,
} from "./language-model"

export type ModelKind = "language" | "image" | "video" | "embedding"

/** Common catalog identity shared by every present and future model runtime. */
export interface ModelDefinition {
  readonly kind: ModelKind
  readonly providerId: string
  readonly modelId: string
  readonly name?: string
  readonly description?: string
  readonly family?: string
  readonly tags?: readonly string[]
  readonly releaseDate?: string
}

/** Serializable facts about one concrete model offering from one provider. */
export interface LanguageModelDefinition extends ModelDefinition {
  readonly kind: "language"
  readonly knowledgeCutoff?: string
  readonly contextWindow?: number
  /** Maximum input tokens, distinct from a shared input/output context window. */
  readonly maxInputTokens?: number
  readonly maxOutputTokens?: number
  readonly capabilities: ModelCapabilities
}

export function defineLanguageModel(definition: LanguageModelDefinition): LanguageModelDefinition {
  if (definition.kind !== "language") {
    throw new TypeError("[Sixb] Language model definitions must use kind 'language'.")
  }
  assertModelId(definition.providerId, "providerId")
  assertModelId(definition.modelId, "modelId")
  assertOptionalString(definition.name, "name")
  assertOptionalString(definition.description, "description")
  assertOptionalString(definition.family, "family")
  assertOptionalString(definition.releaseDate, "releaseDate")
  assertOptionalString(definition.knowledgeCutoff, "knowledgeCutoff")
  const tags = freezeStrings(definition.tags, "tags")
  const capabilities = defineModelCapabilities(definition.capabilities)
  assertOptionalPositiveInteger(definition.contextWindow, "contextWindow")
  assertOptionalPositiveInteger(definition.maxInputTokens, "maxInputTokens")
  assertOptionalPositiveInteger(definition.maxOutputTokens, "maxOutputTokens")
  return Object.freeze({
    kind: "language",
    providerId: definition.providerId,
    modelId: definition.modelId,
    ...(definition.name === undefined ? {} : { name: definition.name }),
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...(definition.family === undefined ? {} : { family: definition.family }),
    ...(tags === undefined ? {} : { tags }),
    ...(definition.releaseDate === undefined ? {} : { releaseDate: definition.releaseDate }),
    ...(definition.knowledgeCutoff === undefined
      ? {}
      : { knowledgeCutoff: definition.knowledgeCutoff }),
    ...(definition.contextWindow === undefined ? {} : { contextWindow: definition.contextWindow }),
    ...(definition.maxInputTokens === undefined
      ? {}
      : { maxInputTokens: definition.maxInputTokens }),
    ...(definition.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: definition.maxOutputTokens }),
    capabilities,
  })
}

function defineModelCapabilities(capabilities: unknown): ModelCapabilities {
  assertRecord(capabilities, "capabilities")
  const inputMediaTypes =
    capabilities.inputMediaTypes === "any"
      ? "any"
      : freezeStrings(capabilities.inputMediaTypes, "capabilities.inputMediaTypes")
  for (const [field, value] of Object.entries(capabilities)) {
    if (field === "inputMediaTypes" || field === "reasoning") continue
    if (value !== undefined && typeof value !== "boolean") {
      throw new TypeError(`[Sixb] Model capability '${field}' must be boolean.`)
    }
  }
  const reasoning = freezeReasoningCapabilities(capabilities.reasoning)
  const flags: {
    localTools?: boolean
    parallelToolCalls?: boolean
    nativeStructuredOutput?: boolean
    providerExecutedTools?: boolean
  } = {}
  for (const key of [
    "localTools",
    "parallelToolCalls",
    "nativeStructuredOutput",
    "providerExecutedTools",
  ] as const) {
    const value = capabilities[key]
    if (typeof value === "boolean") flags[key] = value
  }
  return Object.freeze({
    ...(inputMediaTypes === undefined ? {} : { inputMediaTypes }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...flags,
  })
}

function freezeReasoningCapabilities(reasoning: unknown): ModelCapabilities["reasoning"] {
  if (reasoning === undefined || reasoning === false) return reasoning
  assertRecord(reasoning, "reasoning")
  if (reasoning.canDisable !== undefined && typeof reasoning.canDisable !== "boolean") {
    throw new TypeError("[Sixb] Model reasoning capability 'canDisable' must be boolean.")
  }
  const efforts = freezeReasoningEfforts(reasoning.efforts)
  const budgetTokens = freezeReasoningBudgetCapabilities(reasoning.budgetTokens)
  return Object.freeze({
    ...(reasoning.canDisable === undefined ? {} : { canDisable: reasoning.canDisable }),
    ...(efforts === undefined ? {} : { efforts }),
    ...(budgetTokens === undefined ? {} : { budgetTokens }),
  } satisfies ModelReasoningCapabilities)
}

function freezeReasoningEfforts(
  efforts: unknown
): readonly (typeof MODEL_REASONING_EFFORTS)[number][] | undefined {
  if (efforts === undefined) return undefined
  if (!Array.isArray(efforts)) {
    throw new TypeError("[Sixb] Model reasoning capability 'efforts' must be an array.")
  }
  const seen = new Set<string>()
  return Object.freeze(
    efforts.map((value: unknown) => {
      const effort = MODEL_REASONING_EFFORTS.find((allowed) => allowed === value)
      if (effort === undefined) {
        throw new TypeError(`[Sixb] Model reasoning effort '${String(value)}' is invalid.`)
      }
      if (seen.has(effort)) {
        throw new TypeError(`[Sixb] Model reasoning effort '${effort}' is duplicated.`)
      }
      seen.add(effort)
      return effort
    })
  )
}

function freezeReasoningBudgetCapabilities(
  budget: unknown
): ModelReasoningBudgetCapabilities | undefined {
  if (budget === undefined) return undefined
  assertRecord(budget, "reasoning budgetTokens")
  assertOptionalNonnegativeInteger(budget.min, "capabilities.reasoning.budgetTokens.min")
  assertOptionalNonnegativeInteger(budget.max, "capabilities.reasoning.budgetTokens.max")
  if (budget.min !== undefined && budget.max !== undefined && budget.max < budget.min) {
    throw new TypeError(
      "[Sixb] Model reasoning token budget maximum must not be below its minimum."
    )
  }
  return Object.freeze({
    ...(budget.min === undefined ? {} : { min: budget.min }),
    ...(budget.max === undefined ? {} : { max: budget.max }),
  })
}

function assertModelId(value: string, field: string): void {
  if (!value.trim()) throw new TypeError(`[Sixb] Model ${field} must not be empty.`)
}

function assertOptionalPositiveInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`[Sixb] Model ${field} must be a positive safe integer.`)
  }
}

function assertOptionalNonnegativeInteger(
  value: unknown,
  field: string
): asserts value is number | undefined {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new TypeError(`[Sixb] Model ${field} must be a nonnegative safe integer.`)
  }
}

function assertOptionalString(value: string | undefined, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new TypeError(`[Sixb] Model ${field} must be a string.`)
  }
}

function freezeStrings(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new TypeError(`[Sixb] Model ${field} must contain nonempty strings.`)
  }
  return Object.freeze([...value])
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`[Sixb] Model ${field} must be an object.`)
}
