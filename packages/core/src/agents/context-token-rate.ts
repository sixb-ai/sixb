import type { LanguageModel, LanguageModelStreamEvent } from "../models"
import type { AgentTokenRateStore } from "../storage/agents"
import {
  AGENT_TOKEN_RATE_MAX_BYTES_PER_TOKEN,
  AGENT_TOKEN_RATE_MIN_BYTES_PER_TOKEN,
  AGENT_TOKEN_RATE_SAMPLES,
} from "../storage/agents/types"
import { type AgentContextSize, measureAgentModelRequest } from "./context-compaction"

/**
 * UTF-8 bytes per token of the text an agent request carries (system prompt, tool catalog,
 * messages, tool results), learned per model from the project's own runs.
 *
 * Each run keeps what its latest model call measured: the bytes of its request as the estimator
 * weighs them, against the input tokens the provider counted (see AgentTokenRateStore). The call
 * is measured where it is made, by the run's session (see measuringAgentContextTokenRates): a
 * runner, which may be a person's own computer, never reports one. A run's
 * rate is a low quantile of its model's newest measurements, the project's and its own calls'
 * alike, and a thread corrects it from its own calls. A tokenizer that changes is followed within
 * a few runs, and a model no run measured yet starts on the dense side until its first call
 * counts: an underestimate is the costly error, as it crosses the window unseen.
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
 * for it, less those the measure already counts as such (overheads). None when the request holds
 * too little text to tell, or any image: an image counts as the most a provider charges for one,
 * so the text's share of the count comes out low, and the rate sparse, the unsafe side.
 */
export function measureAgentContextTokenRate(input: {
  readonly size: AgentContextSize
  readonly inputTokens: number
}): AgentContextTokenRateSample | undefined {
  const { size } = input
  if ((size.images ?? 0) > 0) return undefined

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

/**
 * A run's rate: a low quantile of its model's newest measurements, newest first, else the default.
 * A run puts its own calls' in front of the project's, so its first call sets the rate of a model
 * no run measured, and barely moves a model's 20.
 */
export function learnedAgentContextBytesPerToken(
  samples: readonly AgentContextTokenRateSample[]
): number {
  return rateQuantile(samples, LEARNED_RATE_QUANTILE)
}

/**
 * Nearest rank: the smallest rate at least `quantile` of the newest measurements reach down to,
 * within the band a tokenizer can measure (see AGENT_TOKEN_RATE_MIN_BYTES_PER_TOKEN).
 */
function rateQuantile(samples: readonly AgentContextTokenRateSample[], quantile: number): number {
  if (samples.length === 0) return AGENT_CONTEXT_DEFAULT_BYTES_PER_TOKEN

  const rates = samples
    .slice(0, AGENT_TOKEN_RATE_SAMPLES)
    .map((sample) => sample.bytes / sample.tokens)
    .sort((a, b) => a - b)
  const rate = rates[Math.max(1, Math.ceil(rates.length * quantile)) - 1]!
  return Math.min(
    AGENT_TOKEN_RATE_MAX_BYTES_PER_TOKEN,
    Math.max(AGENT_TOKEN_RATE_MIN_BYTES_PER_TOKEN, rate)
  )
}

/**
 * What the project's runs measured on `model` lately, newest first, read once with a run's plan.
 * The measurements are a cache: a project whose storage cannot read them has none, and its runs
 * start from the default, which errs high.
 */
export async function readAgentContextTokenRates(input: {
  readonly tokenRates: AgentTokenRateStore
  readonly projectId: string
  readonly model: { readonly providerId: string; readonly modelId: string }
}): Promise<readonly AgentContextTokenRateSample[]> {
  const { projectId, model } = input

  try {
    const samples = await input.tokenRates.listLatest({
      projectId,
      providerId: model.providerId,
      modelId: model.modelId,
    })
    return samples.map(({ bytes, tokens }) => ({ bytes, tokens }))
  } catch (error) {
    console.warn(
      `[Sixb] Could not read the bytes per token measured for '${model.providerId}/${model.modelId}'; estimating its context at ${AGENT_CONTEXT_DEFAULT_BYTES_PER_TOKEN} until a call counts.`,
      error
    )
    return []
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

/**
 * `model`, its calls each keeping what they measured of its tokenizer once they end: the run's
 * latest call stands for the run (see AgentTokenRateStore.record). Best effort, as
 * recordAgentContextTokenRate is.
 */
export function measuringAgentContextTokenRates(
  model: LanguageModel,
  run: {
    readonly tokenRates: AgentTokenRateStore
    readonly projectId: string
    readonly runId: string
  }
): LanguageModel {
  return {
    ...model,
    stream: async (request) => {
      const size = measureAgentModelRequest(request)
      const stream = await model.stream(request)
      return { ...stream, events: measuredEvents(stream.events, size, model, run) }
    },
  }
}

/** The call's events as they come; once they end, what the provider counted is measured. */
async function* measuredEvents(
  events: AsyncIterable<LanguageModelStreamEvent>,
  size: AgentContextSize,
  model: LanguageModel,
  run: Parameters<typeof measuringAgentContextTokenRates>[1]
): AsyncIterable<LanguageModelStreamEvent> {
  let inputTokens: number | undefined
  for await (const event of events) {
    if (event.type === "finish") inputTokens = event.usage.inputTokens

    yield event
  }

  const sample =
    inputTokens === undefined ? undefined : measureAgentContextTokenRate({ size, inputTokens })
  if (!sample) return

  await recordAgentContextTokenRate({
    ...run,
    sample: { providerId: model.providerId, modelId: model.modelId, ...sample },
    measuredAt: new Date(),
  })
}
