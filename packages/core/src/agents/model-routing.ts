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
import { type AgentTurnPlace, runPlaceKey } from "../storage/agents/provider"

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

/** How much of the previous message the decision model reads: enough to tell what work it set. */
const PREVIOUS_MESSAGE_CHARS = 2_000

/** What each tier is for, whatever the project: its models' descriptions say how it uses them. */
const TIER_WORK: Readonly<Record<LanguageModelTier, string>> = {
  light:
    "A lookup, a count, a filter or a list with an obvious answer. Greetings, thanks, and short " +
    "questions that start no new work.",
  standard:
    "Usual work with a clear path: several queries or reads, a comparison, a short summary, a " +
    "simple action, or a small change to a few files.",
  heavy:
    "Open-ended or long work: a multi-step investigation, explaining why something happened, " +
    "weighing trade-offs, building a plan, writing a long report, or changes across many files " +
    "that must be checked.",
}

/**
 * The tier question for a project: the work each tier is for, and the description of the model a
 * routed turn runs on in that tier, which the project can write to steer the choice.
 */
function tierQuestions(language: LanguageModelCatalog) {
  return {
    tier: question.choice({
      instructions:
        "A user sent this message to an agent that works in a project with tools: it reads and " +
        "changes the project's data, runs actions, writes documents, and in a workspace runs " +
        "commands and edits files. Pick the model tier the answer needs. Judge the work the " +
        "answer takes, not the length or tone of the message. When the input holds the " +
        "previous message, with the tier it ran on, judge the <message> in its light: a short " +
        "message that carries on that work, such as approving a plan or asking for the next " +
        "step, takes the tier the work needs.",
      options: {
        light: tierOption(language, "light"),
        standard: tierOption(language, "standard"),
        heavy: tierOption(language, "heavy"),
      },
    }),
  }
}

function tierOption(language: LanguageModelCatalog, tier: LanguageModelTier): string {
  const description = language.tiers.includes(tier)
    ? language.getByTier(tier).model.definition.description?.trim()
    : undefined

  return description ? `${TIER_WORK[tier]} This tier's model: ${description}` : TIER_WORK[tier]
}

export interface TurnModelChoice {
  readonly model: LanguageModelEntry
  /**
   * The decision model's answer; absent when it failed, or had no words to judge, and the turn
   * aimed for `standard`.
   */
  readonly tierProbabilities?: LanguageModelTierProbabilities
}

/** A turn whose model Sixb picks. */
export interface TurnToRoute {
  /** The words of its message. */
  readonly text: string
  /** The thread's previous turn, absent for its first. */
  readonly previous?: {
    readonly run: ConversationAgentRunRecord
    /** The words of the message that started it, which a short follow-up carries on. */
    readonly text?: string
  }
  /** Where the turn runs: the previous turn's cache holds its prompt only if it ran there. */
  readonly place: AgentTurnPlace
}

export interface TurnModelRouter {
  /** The model of a turn that names none. */
  choose(turn: TurnToRoute): Promise<TurnModelChoice>
}

/**
 * With tiers, the default decision model picks the tier of each turn, so it must take the question.
 * Checked at startup: a model that cannot would leave every turn on `standard`, warning each time.
 */
export function assertTurnModelRouting(models: ModelCatalog | undefined): void {
  const language = models?.language
  const decision = models?.decision?.default
  if (!language || language.tiers.length === 0 || !decision) return

  const { tier } = tierQuestions(language)
  if (supportsQuestion(decision.model.definition.capabilities, tier)) return

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

  const questions = tierQuestions(language)

  return {
    async choose(turn) {
      const last = turn.previous && previousTurn(language, turn.previous.run, turn.place)

      // Files sent alone leave nothing to judge: the turn aims for standard, and the cache rule
      // keeps a warm thread on its model.
      const tierProbabilities = turn.text.trim()
        ? await askTier(decision, questions, decisionInput(turn, last))
        : undefined
      const tier = tierProbabilities ? tierFor(tierProbabilities) : "standard"

      return {
        model: turnModel(language, tier, last),
        ...(tierProbabilities ? { tierProbabilities } : {}),
      }
    },
  }
}

/**
 * The message, after the one before it and the tier that one ran on: "Go ahead" after a plan for
 * a large change asks for that change, and judged alone it reads like thanks.
 */
function decisionInput(turn: TurnToRoute, last: PreviousTurn | undefined): string {
  const before = turn.previous?.text?.trim()
  if (!before) return turn.text

  const clipped =
    before.length > PREVIOUS_MESSAGE_CHARS ? `${before.slice(0, PREVIOUS_MESSAGE_CHARS)}…` : before
  const tier = last ? ` tier="${last.tier}"` : ""

  return [
    `<previous_message${tier}>`,
    clipped,
    "</previous_message>",
    "",
    "<message>",
    turn.text,
    "</message>",
  ].join("\n")
}

/** The decision model's answer, or nothing when it fails or is too slow. */
async function askTier(
  decision: DecisionModelsRuntime,
  questions: ReturnType<typeof tierQuestions>,
  input: string
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
      decision.evaluate({ input, questions, signal: timeout.signal }),
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
  last: PreviousTurn | undefined
): LanguageModelEntry {
  const target = language.getByTier(tier)
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
  run: ConversationAgentRunRecord,
  place: AgentTurnPlace
): PreviousTurn | undefined {
  if (!run.spec) return undefined

  const model = language.getByRef(run.spec.model)
  const tier = run.spec.tier ?? model?.tier
  if (tier === undefined) return undefined

  // A run that never recorded its end counts from its start, or from its admission. A turn in
  // another workspace sent another system prompt, so its cache does not hold this turn's; one
  // where this turn runs does, however the thread moved in between.
  const lastCallAt = run.completedAt ?? run.startedAt ?? run.createdAt
  const samePlace = runPlaceKey(run.spec) === runPlaceKey(place)
  return {
    model,
    tier,
    cacheWarm: samePlace && Date.now() - lastCallAt.getTime() < PROMPT_CACHE_TTL_MS,
  }
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
