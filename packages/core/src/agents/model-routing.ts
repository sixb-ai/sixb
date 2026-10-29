import type {
  DecisionModelsRuntime,
  LanguageModelCatalog,
  LanguageModelEntry,
  LanguageModelTier,
  LanguageModelTierProbabilities,
  ModelCatalog,
} from "../models"
import { LANGUAGE_MODEL_TIERS } from "../models/catalog"
import { question } from "../models/decision/questions"
import { supportsQuestion } from "../models/decision/validation"
import { RuntimeError } from "../runtime/errors"
import type { ConversationAgentRunRecord } from "../storage/agents"

/** Moving up needs no confidence: a turn goes to `heavy` from this probability. */
const HEAVY_FROM = 0.4

/** Moving down does: a turn goes to `light` only from this probability. */
const LIGHT_FROM = 0.8

/**
 * How long a turn waits for its tier before it aims for `standard`. Jev answers in about 150 ms;
 * the margin covers a gateway's slow start, and every millisecond delays the answer's first token.
 */
const DECISION_TIMEOUT_MS = 2_000

/** How long a provider keeps a thread's prompt cache after the last call that read it. */
const PROMPT_CACHE_TTL_MS = 5 * 60_000

const TIER_QUESTIONS = {
  tier: question.choice({
    instructions:
      "A user sent this message to a data agent. The agent answers from the project's data with " +
      "tools: it searches and reads objects, queries and aggregates datasets, follows links, runs " +
      "actions and writes reports. Pick the model tier the answer needs. Judge the work the " +
      "answer takes, not the length or tone of the message.",
    options: {
      light:
        "A lookup, a count, a filter or a list: one or two queries with an obvious answer. " +
        "Greetings, thanks and short follow-ups.",
      standard:
        "Usual analysis: several queries, comparisons, trends or aggregations, a short summary, " +
        "or a simple action, with a clear path to the answer.",
      heavy:
        "Open-ended work: a multi-step investigation, explaining why something happened, " +
        "weighing trade-offs, building a plan, or writing a long report.",
    },
  }),
}

export interface TurnModelChoice {
  readonly model: LanguageModelEntry
  /**
   * The decision model's answer; absent when it failed, or had no words to judge, and the turn
   * aimed for `standard`.
   */
  readonly tierProbabilities?: LanguageModelTierProbabilities
}

export interface TurnModelRouter {
  /** The model of a turn that names none, given the thread's previous turn. */
  choose(text: string, previous: ConversationAgentRunRecord | undefined): Promise<TurnModelChoice>
}

/**
 * With tiers, the default decision model picks the tier of each turn, so it must take the question.
 * Checked at startup: a model that cannot would leave every turn on `standard`, warning each time.
 */
export function assertTurnModelRouting(models: ModelCatalog | undefined): void {
  const tiers = models?.language?.tiers ?? []
  const decision = models?.decision?.default
  if (tiers.length === 0 || !decision) return
  if (supportsQuestion(decision.model.definition.capabilities, TIER_QUESTIONS.tier)) return

  throw new RuntimeError(
    `[Sixb] The default decision model '${decision.provider}/${decision.modelId}' cannot pick the tier of an Agent turn: it needs 'choice' questions with ${LANGUAGE_MODEL_TIERS.length} options. Put a decision model that supports them first in 'models.decision', or configure 'models.language' as a list.`
  )
}

/** Sixb picks the model of each turn when the project configures tiers and a decision model. */
export function createTurnModelRouter(
  models: ModelCatalog | undefined,
  decision: DecisionModelsRuntime
): TurnModelRouter | undefined {
  const language = models?.language
  if (!language || language.tiers.length === 0 || !models?.decision) return undefined

  return {
    async choose(text, previous) {
      // Files sent alone leave nothing to judge: the turn aims for standard, and the cache rule
      // keeps a warm thread on its model.
      const tierProbabilities = text.trim() ? await askTier(decision, text) : undefined
      const tier = tierProbabilities ? tierFor(tierProbabilities) : "standard"

      return {
        model: turnModel(language, tier, previous),
        ...(tierProbabilities ? { tierProbabilities } : {}),
      }
    },
  }
}

/** The decision model's answer, or nothing when it fails or is too slow. */
async function askTier(
  decision: DecisionModelsRuntime,
  text: string
): Promise<LanguageModelTierProbabilities | undefined> {
  const timeout = new AbortController()
  const timer = setTimeout(() => {
    timeout.abort(
      new DOMException("[Sixb] The decision model did not answer in time.", "TimeoutError")
    )
  }, DECISION_TIMEOUT_MS)

  try {
    // The race holds the turn to its timeout even when a provider ignores the signal.
    const { output } = await Promise.race([
      decision.evaluate({ input: text, questions: TIER_QUESTIONS, signal: timeout.signal }),
      rejectOnAbort(timeout.signal),
    ])
    const { light, standard, heavy } = output.tier.probabilities
    return { light, standard, heavy }
  } catch (error) {
    // The request's own cancellation still cancels the message.
    if (!timeout.signal.aborted && isAbortError(error)) throw error

    console.warn(
      "[Sixb] Could not pick the tier of an Agent turn; it aims for standard, and the cache rule still applies.",
      error
    )
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** Moving down needs confidence; moving up doesn't. */
function tierFor(probabilities: LanguageModelTierProbabilities): LanguageModelTier {
  if (probabilities.heavy >= HEAVY_FROM) return "heavy"
  if (probabilities.light >= LIGHT_FROM) return "light"
  return "standard"
}

/**
 * Switching models drops the prompt cache, so the thread stays on its model unless the switch is
 * free: a harder turn always moves up, an easier one moves down only once the cache is cold.
 */
function turnModel(
  language: LanguageModelCatalog,
  tier: LanguageModelTier,
  previous: ConversationAgentRunRecord | undefined
): LanguageModelEntry {
  const target = language.getByTier(tier)
  const last = previous && previousTurn(language, previous)
  if (!last) return target

  const change = tierRank(target.tier ?? tier) - tierRank(last.tier)
  if (change > 0 || last.model === null) return target
  if (change === 0 || last.cacheWarm) return last.model
  return target
}

interface PreviousTurn {
  /** Null once the model has left the catalog. */
  readonly model: LanguageModelEntry | null
  readonly tier: LanguageModelTier
  readonly cacheWarm: boolean
}

/** An older run without a tier takes its model's; one without either counts as no turn at all. */
function previousTurn(
  language: LanguageModelCatalog,
  run: ConversationAgentRunRecord
): PreviousTurn | undefined {
  if (!run.spec) return undefined

  const model = language.getByRef(run.spec.model)
  const tier = run.spec.tier ?? model?.tier
  if (tier === undefined) return undefined

  // A run that never recorded its end counts from its start, or from its admission.
  const lastCallAt = run.completedAt ?? run.startedAt ?? run.createdAt
  return { model, tier, cacheWarm: Date.now() - lastCallAt.getTime() < PROMPT_CACHE_TTL_MS }
}

function tierRank(tier: LanguageModelTier): number {
  return LANGUAGE_MODEL_TIERS.indexOf(tier)
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === "AbortError"
}
