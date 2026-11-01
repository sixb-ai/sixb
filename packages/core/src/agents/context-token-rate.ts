import type { AgentContextSize } from "./context-compaction"

/**
 * UTF-8 bytes per token of the text an agent request carries (system prompt, tool catalog,
 * messages, tool results), by tokenizer family, on the low side: an underestimate is the costly
 * error, as it crosses the window unseen.
 *
 * Measured on logged Gateway requests (content bytes as the estimator counts them / provider
 * `input_tokens`): Claude (Haiku 5.5) 2.14–2.69 on agent turns, OpenAI (gpt-6.1-terra,
 * gpt-4o-mini) 4.44–4.66, DeepSeek (deepseek-v4.1-flash) 3.08–3.88, median 3.49, over 91 calls of
 * natural-text turns (project lookups, a coding turn, actions). Other tokenizers are unmeasured
 * and start between Claude and OpenAI, below the 3.5–4 most reach on English: any lower and the
 * hard-limit checks refuse conversations that fit. A thread corrects every rate from its first
 * anchored call.
 */
const FAMILY_BYTES_PER_TOKEN: readonly {
  readonly match: RegExp
  readonly bytesPerToken: number
}[] = [
  { match: /claude/i, bytesPerToken: 2.1 },
  { match: /(?:^|[/.])(?:gpt|o\d)(?:[-.]|$)/i, bytesPerToken: 4 },
  { match: /deepseek/i, bytesPerToken: 3.1 },
]
const DEFAULT_BYTES_PER_TOKEN = 3

/** Below this many measured text tokens, per-item overheads dominate and the ratio is noise. */
const CALIBRATION_MIN_TEXT_TOKENS = 1_000

/**
 * How far a thread's measured rate may move from its family's. Down is the safe side and goes to
 * half. Up only a quarter: stored bytes the provider bills for less (replayed reasoning, provider
 * state) raise the measured rate, and an estimate too low crosses the window unseen.
 */
const CALIBRATION_MIN_FACTOR = 0.5
const CALIBRATION_MAX_FACTOR = 1.25

/** The tokenizer family's bytes per token for a model, before any thread calibrates it. */
export function agentContextBytesPerToken(model: { readonly modelId: string }): number {
  return (
    FAMILY_BYTES_PER_TOKEN.find((family) => family.match.test(model.modelId))?.bytesPerToken ??
    DEFAULT_BYTES_PER_TOKEN
  )
}

/**
 * The rate a thread's own traffic shows: what a request it sent weighs, as measured (see
 * measureAgentContextRequest, measureModelRequest), against the input tokens the provider counted
 * for it. What the provider counted that the measure misses (tool-result images, one-off notes)
 * lowers the rate, the safe side; what it holds that the provider bills for less raises it, so the
 * rise is bounded tighter than the fall.
 */
export function calibrateAgentContextBytesPerToken(input: {
  readonly bytesPerToken: number
  readonly size: AgentContextSize
  readonly inputTokens: number
}): number {
  const { size } = input
  const textTokens = input.inputTokens - size.tokens
  if (textTokens < CALIBRATION_MIN_TEXT_TOKENS || size.bytes <= 0) return input.bytesPerToken

  const measured = size.bytes / textTokens
  return Math.min(
    input.bytesPerToken * CALIBRATION_MAX_FACTOR,
    Math.max(input.bytesPerToken * CALIBRATION_MIN_FACTOR, measured)
  )
}
