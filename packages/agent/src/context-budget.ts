import { AgentDefinitionError } from "@sixb/core"
import {
  AGENT_IMAGE_INPUT_TOKENS,
  agentContextBytesPerToken,
  estimateModelRequestTokens,
} from "@sixb/core/internal/agents"
import { modelTokenPriceAt } from "@sixb/core/internal/model-execution"
import {
  defineLanguageModel,
  type LanguageModel,
  type LanguageModelDefinition,
  type LanguageModelRequest,
  type ModelRateCard,
  type ModelReasoning,
  type ModelTokenPrice,
} from "@sixb/core/models"

const DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS = 128_000

/**
 * How much denser than its family a thread may tokenize before a call overflows the window: the
 * ceiling is set when the model is prepared, before the thread's own rate is measured.
 */
const OUTPUT_CEILING_RATE_MARGIN = 1.25

/** What compaction brings the context down to, as a share of the target it crossed. */
export const AGENT_CONTEXT_COMPACTED_SHARE = 0.6

/**
 * The later calls a thread is assumed to make when it has none to go by. Haiku 5.5's ×5 tier pays
 * back within it (about 6 calls); a ×2 tier (about 14 for Gemini 2.5 Pro, 17 for Sonnet 4.5 with
 * hour-long writes) waits for the thread's own history to show it will last.
 */
const FRESH_THREAD_EXPECTED_CALLS = 8

/**
 * The model's two input limits. `inputBudgetTokens` is the hard one: the window less the output
 * reserve, never crossed. The soft one depends on how long the thread will go on, so it is
 * resolved per turn from these facts by {@link resolveAgentContextTarget}.
 */
export interface AgentContextBudget {
  readonly windowTokens: number
  readonly inputBudgetTokens: number
  readonly reserveTokens: number
  readonly source: "model" | "fallback"
  /** UTF-8 bytes per token of the model's tokenizer family, before a thread calibrates it. */
  readonly bytesPerToken: number
  /** The rate card's tiers below the hard limit whose prices rise, lowest first. */
  readonly priceTiers: readonly AgentContextPriceTier[]
}

/** A price tier, and what compacting just below it is worth. */
export interface AgentContextPriceTier {
  /** The smallest request billed at the tier's prices: the tier counts every input token. */
  readonly fromTokens: number
  /** How much dearer re-reading the context is from there: cached reads, else plain input. */
  readonly priceRatio: number
  /**
   * The later calls after which compacting to {@link AGENT_CONTEXT_COMPACTED_SHARE} of the tier
   * costs less than re-reading the whole context above it.
   */
  readonly breakEvenCalls: number
}

/** Where one turn keeps its context, and why. */
export interface AgentContextTarget {
  /** Compaction starts once an estimate crosses it. */
  readonly tokens: number
  /** A price tier that pays back to stay under, or the hard limit itself. */
  readonly limit: "price-tier" | "window"
  /** The tier the target stays under; with a `window` limit, the lowest one, which did not pay. */
  readonly tier?: AgentContextPriceTier
  /** The later calls the decision assumed. */
  readonly expectedRemainingCalls: number
  /** The recent work compaction keeps verbatim. */
  readonly keepRecentTokens: number
}

interface AgentModelSelection {
  readonly model: LanguageModel
  readonly reasoning?: ModelReasoning
}

/**
 * Derive the model's input and output budgets from its definition, and cap each call's output to
 * them. The model comes pinned: whoever hands it over resolved it once for the run.
 */
export function prepareAgentModel(selection: AgentModelSelection): {
  readonly model: LanguageModel
  readonly budget: AgentContextBudget
} {
  const model = selection.model
  const definition = defineLanguageModel(model.definition)
  const budget = resolveAgentContextBudget(selection, definition)
  if (budget.source === "fallback") {
    console.warn(
      `[SixbAgent] No context limit is available for '${model.providerId}/${model.modelId}'; using the ${DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS.toLocaleString("en-US")}-token fallback.`
    )
  }
  const maxOutputTokens = outputCapTokens(selection.model, definition) ?? budget.reserveTokens
  if (
    typeof selection.reasoning === "object" &&
    selection.reasoning.budgetTokens >= maxOutputTokens
  ) {
    throw invalidBudget("output allowance must exceed the reasoning token budget.")
  }
  return {
    budget,
    model: Object.freeze({
      providerId: model.providerId,
      modelId: model.modelId,
      definition: defineLanguageModel({ ...definition, maxOutputTokens }),
      costEstimator: model.costEstimator,
      ...(model.validateResponseFormat === undefined
        ? {}
        : { validateResponseFormat: model.validateResponseFormat.bind(model) }),
      stream: (request: LanguageModelRequest) =>
        model.stream({
          ...request,
          maxOutputTokens: Math.min(
            request.maxOutputTokens ?? maxOutputTokens,
            outputCeilingTokens(request, budget, maxOutputTokens)
          ),
        }),
    }),
  }
}

/**
 * A call may write whatever its input leaves of the window, up to the cap. Compaction keeps the
 * input within its budget, so the reserve is always left.
 */
function outputCeilingTokens(
  request: LanguageModelRequest,
  budget: AgentContextBudget,
  capTokens: number
): number {
  const inputTokens = estimateRequestInputTokens(
    request,
    budget.bytesPerToken / OUTPUT_CEILING_RATE_MARGIN
  )
  return Math.min(capTokens, Math.max(budget.reserveTokens, budget.windowTokens - inputTokens))
}

/**
 * The conversation estimator at the model's family rate, which errs low on bytes per token: an
 * underestimate is the costly side, as whenever the window bounds the ceiling, any input it misses
 * overflows providers that reject input plus output beyond the window.
 *
 * An image counts as the most a provider charges for one, never as its base64 bytes. Attachments
 * stay in a thread's requests until compaction, so giving up on any file would cap every later
 * call of the thread at the reserve. Other inline files count by their encoded bytes.
 */
function estimateRequestInputTokens(request: LanguageModelRequest, bytesPerToken: number): number {
  let fileTokens = 0
  for (const message of request.messages) {
    if (message.role !== "user") continue

    for (const part of message.content) {
      if (part.type !== "file") continue

      fileTokens += part.mediaType.startsWith("image/")
        ? AGENT_IMAGE_INPUT_TOKENS
        : Math.ceil(new TextEncoder().encode(part.data.href).byteLength / bytesPerToken)
    }
  }

  return estimateModelRequestTokens(request, bytesPerToken) + fileTokens
}

/** The most one call may write: the binding's limit, capped at the model maximum. */
function outputCapTokens(
  binding: LanguageModel,
  definition: LanguageModelDefinition
): number | undefined {
  if (binding.maxOutputTokens === undefined) return definition.maxOutputTokens
  return Math.min(binding.maxOutputTokens, definition.maxOutputTokens ?? binding.maxOutputTokens)
}

/**
 * Input-only limits are a conservative window: leave the same reserve without inventing a total.
 * The reserve is the output every call is guaranteed, not its ceiling, so it stays small and a
 * larger output limit never shrinks the input budget.
 */
export function resolveAgentContextBudget(
  selection: AgentModelSelection,
  definition: LanguageModelDefinition = selection.model.definition
): AgentContextBudget {
  const modelWindow = definition.contextWindow ?? definition.maxInputTokens
  const windowTokens = modelWindow ?? DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS
  const reserveTokens = Math.max(
    Math.min(
      16_384,
      Math.floor(windowTokens * 0.25),
      outputCapTokens(selection.model, definition) ?? Number.POSITIVE_INFINITY
    ),
    typeof selection.reasoning === "object" ? selection.reasoning.budgetTokens + 1 : 0
  )
  assertPositiveSafeInteger(windowTokens, "windowTokens")
  assertPositiveSafeInteger(reserveTokens, "reserveTokens")
  if (reserveTokens >= windowTokens) {
    throw invalidBudget("reserveTokens must be less than the resolved context window.")
  }
  const inputBudgetTokens = Math.min(
    definition.maxInputTokens ?? Number.POSITIVE_INFINITY,
    windowTokens - reserveTokens
  )
  assertPositiveSafeInteger(inputBudgetTokens, "inputBudgetTokens")
  assertRoomForRecentWork(inputBudgetTokens)

  return Object.freeze({
    windowTokens,
    inputBudgetTokens,
    reserveTokens,
    source: modelWindow === undefined ? "fallback" : "model",
    bytesPerToken: agentContextBytesPerToken(selection.model),
    // Known limit: a Gateway model whose definition the project supplies resolves offline and
    // carries no rate card until the catalog has loaded, so its soft limit is the hard one.
    priceTiers: Object.freeze(
      contextPriceTiers(selection.model.rateCard, { inputBudgetTokens, reserveTokens })
    ),
  })
}

/**
 * The soft limit for a turn: the lowest price tier that compacting before pays back within the
 * calls the thread is expected to make, else the hard limit. Without an expectation (a fresh
 * thread, a child, a workflow step) it assumes {@link FRESH_THREAD_EXPECTED_CALLS}.
 */
export function resolveAgentContextTarget(
  budget: AgentContextBudget,
  options: { readonly expectedRemainingCalls?: number } = {}
): AgentContextTarget {
  const expectedRemainingCalls = Math.max(
    FRESH_THREAD_EXPECTED_CALLS,
    options.expectedRemainingCalls ?? 0
  )
  const tier = budget.priceTiers.find((tier) => tier.breakEvenCalls < expectedRemainingCalls)
  const tokens = tier ? tier.fromTokens - 1 : budget.inputBudgetTokens
  const considered = tier ?? budget.priceTiers[0]

  return Object.freeze({
    tokens,
    limit: tier ? "price-tier" : "window",
    ...(considered ? { tier: considered } : {}),
    expectedRemainingCalls,
    keepRecentTokens: keepRecentTokensFor(tokens),
  })
}

/**
 * The calls a thread has left, judged by its own record: as many turns again as it has had, plus
 * the one starting, each as long as its turns have been on average. Undefined before its first
 * answer. Summarized turns count two messages each.
 */
export function expectedRemainingAgentCalls(history: {
  readonly checkpoint: { readonly summarizedThroughSeq: number } | null
  readonly messages: readonly {
    readonly role: string
    readonly parts: readonly { readonly type: string }[]
  }[]
}): number | undefined {
  const answers = history.messages.filter((message) => message.role === "assistant")
  if (answers.length === 0) return undefined

  const steps = answers.reduce(
    (total, answer) =>
      total + Math.max(1, answer.parts.filter((part) => part.type === "step-start").length),
    0
  )
  const turns = answers.length + Math.floor((history.checkpoint?.summarizedThroughSeq ?? 0) / 2)
  return Math.ceil((steps / answers.length) * (turns + 1))
}

/** The summary call's output allowance, which the price of compacting includes. */
export function contextSummaryOutputTokens(reserveTokens: number): number {
  return Math.min(8_192, Math.max(1, Math.floor(reserveTokens / 2)))
}

/**
 * Each tier boundary below the hard limit where re-reading the context gets dearer, with its
 * break-even: crossing it bills every later call the whole context `C` at the tier's rate, while
 * compacting just below it costs once, rewriting `C' = 0.6 C` and the summary (reading `C` and
 * writing its output):
 *
 *   n* = (C' × write_low + C × input_low + summary × output_low) / (C × read_high − C' × read_low)
 *
 * The summary is a one-shot request, so it reads `C` at the plain input price. Once it continues
 * the cached conversation instead, that term becomes `C × read_low`.
 *
 * Writes go at the card's one-hour price when it has one, as conversations are cached that long.
 * A tier whose prices do not rise is no reason to compact, however long the thread.
 */
function contextPriceTiers(
  card: ModelRateCard | undefined,
  limits: { readonly inputBudgetTokens: number; readonly reserveTokens: number }
): AgentContextPriceTier[] {
  if (!card?.input || !card.output) return []
  const input = card.input
  const output = card.output
  const read = card.cacheReadInput ?? input
  const write = card.cacheWriteInput1h ?? card.cacheWriteInput ?? card.cacheWriteInput5m ?? input
  const summaryTokens = contextSummaryOutputTokens(limits.reserveTokens)

  // A tier below one call's output could hold no conversation.
  const boundaries = [
    ...new Set([input, output, read, write].flatMap((price) => tierBoundaries(price))),
  ]
    .filter((tokens) => tokens > limits.reserveTokens && tokens <= limits.inputBudgetTokens)
    .sort((a, b) => a - b)

  return boundaries.flatMap((fromTokens) => {
    const below = (price: ModelTokenPrice) => Number(modelTokenPriceAt(price, fromTokens - 1))
    const above = (price: ModelTokenPrice) => Number(modelTokenPriceAt(price, fromTokens))
    if (above(read) <= below(read) && above(input) <= below(input)) return []

    const context = fromTokens
    const compacted = AGENT_CONTEXT_COMPACTED_SHARE * fromTokens
    const compacting =
      compacted * below(write) + context * below(input) + summaryTokens * below(output)
    const savedPerCall = context * above(read) - compacted * below(read)
    const ratio = (price: ModelTokenPrice) => above(price) / below(price)

    return [
      {
        fromTokens,
        priceRatio: below(read) > 0 ? ratio(read) : ratio(input),
        breakEvenCalls: compacting / savedPerCall,
      },
    ]
  })
}

function tierBoundaries(price: ModelTokenPrice): number[] {
  return typeof price === "string" ? [] : price.tiers.map((tier) => tier.minTokens)
}

function keepRecentTokensFor(targetTokens: number): number {
  assertRoomForRecentWork(targetTokens)
  return Math.min(20_000, Math.floor(targetTokens * 0.5))
}

/** A limit too small to keep any recent work verbatim is no budget. */
function assertRoomForRecentWork(limitTokens: number): void {
  const keepRecentTokens = Math.min(20_000, Math.floor(limitTokens * 0.5))
  assertPositiveSafeInteger(keepRecentTokens, "keepRecentTokens")
  if (keepRecentTokens >= limitTokens) {
    throw invalidBudget("keepRecentTokens must be less than the resolved input budget.")
  }
}

function invalidBudget(message: string): AgentDefinitionError {
  return new AgentDefinitionError(`[SixbAgent] Agent context ${message}`)
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidBudget(`${field} must be a positive safe integer.`)
  }
}
