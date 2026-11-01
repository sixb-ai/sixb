import type {
  PrepareModelStepInput,
  PrepareModelStepResult,
  RecoverModelStepInput,
} from "@sixb/core/internal/agents"
import {
  type ModelMessage,
  ModelProviderError,
  type ModelStep,
  type ModelToolResultPart,
  type ModelToolSpecification,
} from "@sixb/core/models"
import type { AgentContextCheckpointReason } from "@sixb/core/storage"
import { stableJsonStringify } from "@sixb/core/storage"
import {
  AGENT_CONTEXT_COMPACTED_SHARE,
  type AgentContextBudget,
  estimateAgentRequestTokens,
} from "./context-budget"

/**
 * The three most recent tool results the model has read always stay, as Anthropic's
 * `clear_tool_uses` keeps by default: the work in progress reads from them. Clearing goes oldest
 * first down to the aim.
 */
const KEPT_TOOL_RESULTS = 3

/**
 * What clearing has to free, as a share of the limit, to be worth the cache it breaks: every
 * request after it rewrites the conversation from the first result it cleared.
 */
const CLEARED_AT_LEAST_SHARE = 0.1

/** A result smaller than this stays as it is: the note that replaces it weighs about as much. */
const CLEARED_MIN_BYTES = 1_024

/** How far a step's estimated growth may run over what it really adds, as a share of it. */
const GROWTH_MARGIN = 0.1

/** A result the model has not read, cut to fit the model's limit, keeps at least this much. */
const CUT_MIN_BYTES = 512

/** What a turn's requests start with in place of the turn's history, once it compacted. */
export type CompactConversationBeforeTurn = (input: {
  readonly reason: AgentContextCheckpointReason
  /** What the request the turn is about to send weighs. */
  readonly estimatedInputTokens: number
}) => Promise<readonly ModelMessage[] | undefined>

export interface AgentContextGuardInput {
  /** Its `inputBudgetTokens` is the limit the turn's requests keep under. */
  readonly budget: AgentContextBudget
  /** The tools every request sends. */
  readonly tools: readonly ModelToolSpecification[]
  /** The bytes per token the turn measured its history at, else the model family's. */
  readonly bytesPerToken?: number
  /** Tools whose results are never cleared. */
  readonly excludeTools?: readonly string[]
  /**
   * Compacts what comes before the turn, once: the messages the turn's requests start with from
   * then on, in place of those they started with. Undefined when it could not.
   */
  readonly compact?: CompactConversationBeforeTurn
}

export interface AgentContextGuard {
  /** Before each call: the request, reduced when it would cross the model's limit. */
  readonly prepareStep: (
    input: PrepareModelStepInput
  ) => Promise<PrepareModelStepResult | undefined>
  /** After a call the provider rejected as too long for the window: the request reduced to fit. */
  readonly recoverStep: (
    input: RecoverModelStepInput
  ) => Promise<PrepareModelStepResult | undefined>
  /**
   * The first step whose request had tool results cleared or cut, which every later one keeps:
   * those steps' usage weighs less than replaying the stored steps sends.
   */
  readonly reducedFromStep: () => number | undefined
}

/**
 * Keep every request of a model loop under the model's limit (the window less the output reserve),
 * checked before each call from what the last call really read and what was added since. Right
 * before a request would cross it:
 *
 * 1. clear the oldest tool results the model has read, all but the {@link KEPT_TOOL_RESULTS} most
 *    recent, in one batch that frees enough to be worth the cache it breaks, down to
 *    {@link AGENT_CONTEXT_COMPACTED_SHARE} of the limit, so the steps after it read the cleared
 *    request through;
 * 2. else compact what came before the turn, once, and clear again what is still needed;
 * 3. past the limit even so, clear as many of the results the model has read as it takes, the
 *    {@link KEPT_TOOL_RESULTS} most recent still kept, and cut those it has not read to fit.
 *
 * A call the provider rejects as too long for the window is measured at the window at least, and
 * reduced the same way, compacting first when it can, for the loop to ask it again once.
 *
 * The first call has no call before it to go by: its whole request is estimated, at the rate the
 * thread measured.
 */
export function createAgentContextGuard(input: AgentContextGuardInput): AgentContextGuard {
  const guard = new ContextGuard(input)
  return {
    prepareStep: (step) => guard.prepareStep(step),
    recoverStep: (step) => guard.recoverStep(step),
    reducedFromStep: () => guard.reducedFrom,
  }
}

/** A cleared tool result's note: the same bytes whenever it replaces that tool's result. */
export function clearedToolResultText(toolName: string): string {
  return `[This ${toolName} result was cleared to fit the model's context. Call the tool again to see it, unless running it again would repeat a change.]`
}

class ContextGuard {
  /** How many messages the loop's first request held: what comes before the turn's own steps. */
  private headLength: number | undefined
  /** The request each step sent, by step index: its last attempt's. */
  private readonly sent = new Map<number, readonly ModelMessage[]>()
  /**
   * How much more the provider counts what a turn adds than the estimate does, once a rejection
   * showed it. What the last call read is counted already, and what is removed from it is not
   * scaled.
   */
  private scale = 1
  private compacted = false
  /** The first step whose request had tool results cleared or cut. */
  reducedFrom: number | undefined
  /** Whether the request `reduce` returned last had tool results cleared or cut. */
  private cleared = false
  private readonly excluded: ReadonlySet<string>

  constructor(private readonly input: AgentContextGuardInput) {
    this.excluded = new Set(input.excludeTools ?? [])
  }

  private get bytesPerToken(): number {
    return this.input.bytesPerToken ?? this.input.budget.bytesPerToken
  }

  async prepareStep({
    stepIndex,
    messages,
    steps,
  }: PrepareModelStepInput): Promise<PrepareModelStepResult | undefined> {
    this.headLength ??= messages.length

    // The growth since the last call is what the estimate may miss. The first call has none to
    // go by: its whole request is estimated, at the rate the thread measured, as its preflight
    // weighed it.
    const { fixed, added } = this.measure(messages, steps)
    const margin = fixed > 0 ? Math.ceil(added * this.scale * GROWTH_MARGIN) : 0
    const tokens = this.projectedTokens(messages, steps) + margin
    const reduced =
      tokens > this.input.budget.inputBudgetTokens
        ? await this.reduce(messages, steps, tokens, "threshold")
        : undefined

    this.record(stepIndex, reduced ?? messages)
    return reduced ? { messages: reduced } : undefined
  }

  async recoverStep({
    stepIndex,
    messages,
    steps,
    error,
    usage,
  }: RecoverModelStepInput): Promise<PrepareModelStepResult | undefined> {
    if (!(error instanceof ModelProviderError) || error.reason !== "context-window-exceeded") {
      return undefined
    }
    this.headLength ??= messages.length

    // What the estimate missed is in what was added since the last call the provider read: that
    // part is counted from now on at the rate that makes the request weigh what the provider
    // counted, when the call says (its answer filled the window), else the window at least.
    const { windowTokens } = this.input.budget
    const read = usage?.inputTokens
    const counted = read !== undefined && read > 0 ? read : windowTokens
    const { fixed, removed, added } = this.measure(messages, steps)
    if (added > 0 && counted > fixed - removed) {
      this.scale = Math.max(this.scale, (counted - fixed + removed) / added)
    }

    const reduced = await this.reduce(
      messages,
      steps,
      Math.max(counted, this.projectedTokens(messages, steps)),
      "overflow"
    )
    if (!reduced) return undefined

    this.record(stepIndex, reduced)
    return { messages: reduced }
  }

  /** The request a step sends, and from which step on the requests are reduced. */
  private record(stepIndex: number, messages: readonly ModelMessage[]): void {
    this.sent.set(stepIndex, messages)
    if (this.cleared) this.reducedFrom ??= stepIndex
    this.cleared = false
  }

  /**
   * Bring `messages` under the model's limit, else as close as clearing, compaction and cutting
   * go. Undefined when nothing was worth changing.
   */
  private async reduce(
    messages: readonly ModelMessage[],
    steps: readonly ModelStep[],
    tokens: number,
    reason: AgentContextCheckpointReason
  ): Promise<readonly ModelMessage[] | undefined> {
    const limitTokens = this.input.budget.inputBudgetTokens
    const aimTokens = Math.floor(limitTokens * AGENT_CONTEXT_COMPACTED_SHARE)
    const clearAtLeast = Math.ceil(limitTokens * CLEARED_AT_LEAST_SHARE)
    const overflow = reason === "overflow"
    this.cleared = false

    // 1. A threshold crossed is first met by clearing what the model has read already. A request
    //    the provider rejected compacts first: the estimate it was sent on was wrong.
    if (!overflow) {
      const cleared = this.clear(messages, steps, tokens - aimTokens)
      if (cleared.tokens >= clearAtLeast && tokens - cleared.tokens <= limitTokens) {
        this.cleared = true
        return cleared.messages
      }
    }

    // 2. Compacting summarizes what came before the turn; the turn stays as it is.
    let current = messages
    let currentTokens = tokens
    if (this.input.compact && !this.compacted) {
      this.compacted = true
      const head = await this.input.compact({ reason, estimatedInputTokens: tokens })
      if (head) {
        current = [...head, ...messages.slice(this.headLength)]
        this.headLength = head.length
        currentTokens = this.projectedTokens(current, steps)
        if (currentTokens <= limitTokens) return current
      }
    }

    // 3. What is left of the turn: its results the model has read, cleared in one batch when it
    //    frees enough to be worth the cache it breaks, and whatever it frees past the limit or
    //    when the provider refused the request.
    const cleared = this.clear(current, steps, currentTokens - aimTokens)
    if (overflow || cleared.tokens >= clearAtLeast || currentTokens > limitTokens) {
      if (cleared.messages !== current) this.cleared = true
      current = cleared.messages
      currentTokens = this.projectedTokens(current, steps)
    }

    // Past the limit even so, the results the model has not read are cut to fit it.
    if (currentTokens > limitTokens) {
      const cut = this.cutUnread(current, currentTokens - limitTokens)
      if (cut.messages !== current) this.cleared = true
      current = cut.messages
    }

    return current === messages ? undefined : current
  }

  /**
   * The oldest tool results the model has read, cleared until `neededTokens` are freed or none
   * is left, keeping the most recent {@link KEPT_TOOL_RESULTS}.
   */
  private clear(
    messages: readonly ModelMessage[],
    steps: readonly ModelStep[],
    neededTokens: number
  ): { readonly messages: readonly ModelMessage[]; readonly tokens: number } {
    const counted = this.countedMessages(steps)
    const read = messages.map((message) => message.role).lastIndexOf("assistant")
    const candidates: { readonly message: number; readonly part: number; readonly gain: number }[] =
      []
    for (const [index, message] of messages.entries()) {
      if (index >= read || message.role !== "tool") continue

      for (const [partIndex, part] of message.content.entries()) {
        const bytes = clearableBytes(part)
        if (bytes === undefined || this.excluded.has(part.toolName)) continue

        const placeholder = utf8Bytes(clearedToolResultText(part.toolName))
        candidates.push({
          message: index,
          part: partIndex,
          gain: this.tokensOf(bytes - placeholder, !counted.has(message)),
        })
      }
    }

    const chosen = new Map<number, Set<number>>()
    let tokens = 0
    for (const candidate of candidates.slice(0, -KEPT_TOOL_RESULTS)) {
      if (tokens >= neededTokens) break

      tokens += candidate.gain
      const parts = chosen.get(candidate.message) ?? new Set<number>()
      parts.add(candidate.part)
      chosen.set(candidate.message, parts)
    }
    if (chosen.size === 0) return { messages, tokens: 0 }

    return {
      tokens,
      messages: replaceToolResults(messages, chosen, (part) => ({
        ...withoutOriginalOutput(part),
        output: { type: "text", value: clearedToolResultText(part.toolName) },
      })),
    }
  }

  /**
   * The results of the step the model has not read yet, each cut to the same length, halved
   * until `excessTokens` are freed: they are the turn's newest work, so the model reads what fits
   * of each and learns how to read the rest.
   */
  private cutUnread(
    messages: readonly ModelMessage[],
    excessTokens: number
  ): { readonly messages: readonly ModelMessage[] } {
    const read = messages.map((message) => message.role).lastIndexOf("assistant")
    const unread = new Map<number, Set<number>>()
    let longest = 0
    for (const [index, message] of messages.entries()) {
      if (index <= read || message.role !== "tool") continue

      for (const [partIndex, part] of message.content.entries()) {
        const bytes = clearableBytes(part)
        if (bytes === undefined) continue

        longest = Math.max(longest, bytes)
        const parts = unread.get(index) ?? new Set<number>()
        parts.add(partIndex)
        unread.set(index, parts)
      }
    }

    let maxBytes = Math.floor(longest / 2)
    let cut = messages
    while (maxBytes >= CUT_MIN_BYTES) {
      let freed = 0
      const limit = maxBytes
      cut = replaceToolResults(messages, unread, (part) => {
        const text = toolResultText(part)
        const kept = cutText(text, limit, part.toolName)
        freed += this.tokensOf(utf8Bytes(text) - utf8Bytes(kept), true)
        return { ...withoutOriginalOutput(part), output: { type: "text", value: kept } }
      })
      if (freed >= excessTokens) break

      maxBytes = Math.floor(maxBytes / 2)
    }
    return { messages: cut }
  }

  /**
   * What `messages` weigh as a request: what the last call really read, less what was removed
   * from its request, plus what was added since at the scaled rate. Without a call to go by, the
   * whole request is estimated, at that rate.
   */
  private projectedTokens(messages: readonly ModelMessage[], steps: readonly ModelStep[]): number {
    const { fixed, removed, added } = this.measure(messages, steps)
    return fixed - removed + Math.ceil(added * this.scale)
  }

  /**
   * What the last call read, then the unscaled estimates of the messages its request held that
   * `messages` no longer do, and of those it adds. Messages are compared by identity: the loop
   * keeps the ones it sends again, and a message cleared or compacted is a new one.
   */
  private measure(
    messages: readonly ModelMessage[],
    steps: readonly ModelStep[]
  ): { readonly fixed: number; readonly removed: number; readonly added: number } {
    const read = steps.at(-1)?.usage.inputTokens
    const sent = this.sent.get(steps.length - 1)
    if (read === undefined || read <= 0 || sent === undefined) {
      return { fixed: 0, removed: 0, added: this.rawEstimate(messages) }
    }

    const before = new Set(sent)
    const after = new Set(messages)
    const weigh = (list: readonly ModelMessage[], kept: ReadonlySet<ModelMessage>) =>
      list.reduce((total, message) => total + (kept.has(message) ? 0 : this.weight(message)), 0)
    return { fixed: read, removed: weigh(sent, after), added: weigh(messages, before) }
  }

  /** The messages of the last request the provider counted, which their real tokens include. */
  private countedMessages(steps: readonly ModelStep[]): ReadonlySet<ModelMessage> {
    const read = steps.at(-1)?.usage.inputTokens
    const sent = this.sent.get(steps.length - 1)
    return read !== undefined && read > 0 && sent ? new Set(sent) : new Set()
  }

  private rawEstimate(messages: readonly ModelMessage[]): number {
    return estimateAgentRequestTokens({ messages, tools: this.input.tools }, this.bytesPerToken)
  }

  /** One message's estimate, without the request's own overhead. */
  private weight(message: ModelMessage): number {
    return (
      estimateAgentRequestTokens({ messages: [message], tools: [] }, this.bytesPerToken) -
      estimateAgentRequestTokens({ messages: [], tools: [] }, this.bytesPerToken)
    )
  }

  /** `bytes` as tokens: at the scaled rate when the provider has not counted them yet. */
  private tokensOf(bytes: number, added: boolean): number {
    return Math.max(0, Math.ceil((bytes / this.bytesPerToken) * (added ? this.scale : 1)))
  }
}

/** What a result weighs when clearing it is worth it: text or JSON past the note's own size. */
function clearableBytes(part: ModelToolResultPart): number | undefined {
  if (part.providerExecuted) return undefined
  if (part.output.type !== "text" && part.output.type !== "json") return undefined

  const text = toolResultText(part)
  if (text === clearedToolResultText(part.toolName)) return undefined

  const bytes = utf8Bytes(text)
  return bytes >= CLEARED_MIN_BYTES ? bytes : undefined
}

function toolResultText(part: ModelToolResultPart): string {
  return typeof part.output.value === "string"
    ? part.output.value
    : stableJsonStringify(part.output.value)
}

/** The text up to its last line within `maxBytes`, saying how much was left out. */
function cutText(text: string, maxBytes: number, toolName: string): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= maxBytes) return text

  // A cut inside a multi-byte character drops it.
  const head = new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/�$/, "")
  const lastLine = head.lastIndexOf("\n")
  const kept = (lastLine > 0 ? head.slice(0, lastLine) : head).trimEnd()
  const omitted = bytes.byteLength - utf8Bytes(kept)

  return `${kept}\n[Cut to fit the model's context: ${omitted.toLocaleString("en-US")} more bytes. Call ${toolName} again for a smaller part to read the rest.]`
}

/** `messages` with the chosen tool results replaced, every other message as it was. */
function replaceToolResults(
  messages: readonly ModelMessage[],
  chosen: ReadonlyMap<number, ReadonlySet<number>>,
  replace: (part: ModelToolResultPart) => ModelToolResultPart
): readonly ModelMessage[] {
  return messages.map((message, index) => {
    const parts = chosen.get(index)
    if (!parts || message.role !== "tool") return message

    return {
      role: "tool",
      content: message.content.map((part, partIndex) =>
        parts.has(partIndex) ? replace(part) : part
      ),
    }
  })
}

function withoutOriginalOutput(part: ModelToolResultPart): ModelToolResultPart {
  const { originalOutput: _originalOutput, ...rest } = part
  return rest
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
