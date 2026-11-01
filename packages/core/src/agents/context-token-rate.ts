import type { AgentTokenRateStore } from "../storage/agents"
import type { AgentContextSize } from "./context-compaction"

/**
 * UTF-8 bytes per token of the text an agent request carries (system prompt, tool catalog,
 * messages, tool results), learned per model from the project's own runs.
 *
 * Each run records what its latest model call measured: the bytes of its request as the estimator
 * weighs them, against the input tokens the provider counted (see AgentTokenRateStore). A run's
 * estimate starts from a low quantile of its model's recent measurements, and a thread corrects
 * it from its own calls. A tokenizer that changes is followed within a few runs, and a model no
 * run measured yet starts on the dense side: an underestimate is the costly error, as it crosses
 * the window unseen.
 */

/** Denser than every tokenizer measured on agent turns, so an unmeasured model's estimate errs high. */
export const AGENT_CONTEXT_DEFAULT_BYTES_PER_TOKEN = 2

/** Below this many measured text tokens, per-item overheads dominate and the ratio is noise. */
const CALIBRATION_MIN_TEXT_TOKENS = 1_000

/**
 * How far a thread's measured rate may move from the rate its run started from. Down is the safe
 * side and goes to half. Up only a quarter: stored bytes the provider bills for less (replayed
 * reasoning, provider state) raise the measured rate, and an estimate too low crosses the window
 * unseen.
 */
const CALIBRATION_MIN_FACTOR = 0.5
const CALIBRATION_MAX_FACTOR = 1.25

/**
 * The quantile of a model's recent measurements its runs start from, low so the estimate errs
 * high. Of the 20 a model keeps, it is the second densest: no number of odd sparse runs moves it,
 * and one odd dense run barely does. A denser tokenizer takes over from its second run, a sparser
 * one from its 19th, overestimated meanwhile. Under ten measurements, it is the densest.
 */
const LEARNED_RATE_QUANTILE = 0.1

/** One request's text against the tokens its provider counted for that text. */
export interface AgentContextTokenRateSample {
  readonly bytes: number
  readonly tokens: number
}

/** A measurement, with the model whose tokenizer it measured. */
export interface AgentModelTokenRateSample extends AgentContextTokenRateSample {
  readonly providerId: string
  readonly modelId: string
}

/**
 * What a request a thread sent measures of its model's tokenizer: its bytes, as measured (see
 * measureAgentContextRequest, measureModelRequest), against the input tokens the provider counted
 * for it, less those the measure already counts as such (overheads, images). None when the request
 * holds too little text to tell.
 */
export function measureAgentContextTokenRate(input: {
  readonly size: AgentContextSize
  readonly inputTokens: number
}): AgentContextTokenRateSample | undefined {
  const { size } = input
  const tokens = input.inputTokens - size.tokens
  if (tokens < CALIBRATION_MIN_TEXT_TOKENS || size.bytes <= 0) return undefined

  return { bytes: size.bytes, tokens }
}

/**
 * The rate a thread's own traffic shows, bounded around the rate its run started from. What the
 * provider counted that the measure misses (tool-result images, one-off notes) lowers the rate, the
 * safe side; what it holds that the provider bills for less raises it, so the rise is bounded
 * tighter than the fall.
 */
export function calibrateAgentContextBytesPerToken(input: {
  readonly bytesPerToken: number
  readonly size: AgentContextSize
  readonly inputTokens: number
}): number {
  const sample = measureAgentContextTokenRate(input)
  if (!sample) return input.bytesPerToken

  return Math.min(
    input.bytesPerToken * CALIBRATION_MAX_FACTOR,
    Math.max(input.bytesPerToken * CALIBRATION_MIN_FACTOR, sample.bytes / sample.tokens)
  )
}

/** The rate a run starts from: a low quantile of its model's recent measurements, else the default. */
export function learnedAgentContextBytesPerToken(
  samples: readonly AgentContextTokenRateSample[]
): number {
  if (samples.length === 0) return AGENT_CONTEXT_DEFAULT_BYTES_PER_TOKEN

  const rates = samples.map((sample) => sample.bytes / sample.tokens).sort((a, b) => a - b)
  // Nearest rank: the smallest rate at least this share of the measurements reach down to.
  const rank = Math.max(1, Math.ceil(rates.length * LEARNED_RATE_QUANTILE))
  return rates[rank - 1]!
}

/**
 * The rate a run on `model` starts from, read once with its plan. The measurements are a cache: a
 * project whose storage cannot read them starts from the default, which errs high.
 */
export async function readAgentContextBytesPerToken(input: {
  readonly tokenRates: AgentTokenRateStore
  readonly projectId: string
  readonly model: { readonly providerId: string; readonly modelId: string }
}): Promise<number> {
  const { projectId, model } = input

  try {
    const samples = await input.tokenRates.listLatest({
      projectId,
      providerId: model.providerId,
      modelId: model.modelId,
    })
    return learnedAgentContextBytesPerToken(samples)
  } catch (error) {
    console.warn(
      `[Sixb] Could not read the bytes per token measured for '${model.providerId}/${model.modelId}'; estimating its context at ${AGENT_CONTEXT_DEFAULT_BYTES_PER_TOKEN}.`,
      error
    )
    return AGENT_CONTEXT_DEFAULT_BYTES_PER_TOKEN
  }
}

/**
 * Keep what a run's latest call measured, for the project's next runs on its model. Best effort: a
 * measurement that cannot be written leaves the next runs on the ones before it.
 */
export async function recordAgentContextTokenRate(input: {
  readonly tokenRates: AgentTokenRateStore
  readonly projectId: string
  readonly runId: string
  readonly sample: AgentModelTokenRateSample
  readonly measuredAt: Date
}): Promise<void> {
  const { projectId, runId, sample } = input

  try {
    await input.tokenRates.record({
      projectId,
      runId,
      providerId: sample.providerId,
      modelId: sample.modelId,
      bytes: sample.bytes,
      tokens: sample.tokens,
      measuredAt: input.measuredAt,
    })
  } catch (error) {
    console.warn(
      `[Sixb] Could not keep the bytes per token agent run '${runId}' measured; later runs start from the measurements before it.`,
      error
    )
  }
}
