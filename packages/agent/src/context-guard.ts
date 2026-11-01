import {
  AGENT_TOKEN_RATE_MIN_BYTES_PER_TOKEN,
  measureAgentContextTokenRate,
  measureAgentModelRequest,
  type PrepareModelStepInput,
  type PrepareModelStepResult,
  type RecoverModelStepInput,
} from "@sixb/core/internal/agents"
import {
  type LanguageModel,
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
  agentMinimumAnswerTokens,
  agentOutputRoomTokens,
  estimateAgentRequestTokens,
} from "./context-budget"

/**
 * The most recent tool result the model has read always stays. Clearing goes oldest first, in one
 * batch down to the aim: the three most recent stay whenever clearing the older ones gets there,
 * as Anthropic's `clear_tool_uses` keeps by default, and the batch goes on through them when it
 * does not. Keeping three whatever the aim would clear one more at every step of a turn whose
 * results are large, and break the cache each time.
 */
const KEPT_TOOL_RESULTS = 1

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
}) => Promise<readonly ModelMessage[] | undefined>

export interface AgentContextGuardInput {
  /** Its `inputBudgetTokens` is the limit the turn's requests keep under. */
  readonly budget: AgentContextBudget
  /** The tools every request sends. */
  readonly tools: readonly ModelToolSpecification[]
  /** The bytes per token the turn measured its history at, else the one its run started from. */
  readonly bytesPerToken?: number
  /**
   * What the run's latest counted call measured, around the run's rate (see prepareAgentModel):
   * once there is one, the calls after it go by it, as the output ceiling does.
   */
  readonly measuredBytesPerToken?: () => number | undefined
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
 * 1. clear the oldest tool results the model has read in one batch, down to
 *    {@link AGENT_CONTEXT_COMPACTED_SHARE} of the limit, when it frees at least a tenth of the
 *    limit ({@link CLEARED_AT_LEAST_SHARE}), enough to be worth the cache it breaks: the three most
 *    recent stay when clearing the older ones gets there, only the newest when it does not (see
 *    {@link KEPT_TOOL_RESULTS}), and the steps after it read the cleared request through;
 * 2. else compact what came before the turn, once, and clear again what is still needed;
 * 3. past the limit even so, clear as many of the results the model has read as it takes, the
 *    newest still kept, and cut those it has not read to fit.
 *
 * A result the model asks for again after it was cleared or cut is one the turn needs: it is
 * neither cleared nor cut again, so a turn whose working set does not fit ends on the provider's
 * refusal instead of reading and reducing the same results in turn.
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
  /**
   * The calls whose results this run cleared or cut, by tool and input. A result the model asks
   * for again after that is one it needs: it is never cleared or cut again while it is the newest
   * of its call, or the two would take turns forever when the turn's working set does not fit.
   */
  private readonly reducedCalls = new Map<string, Set<string>>()
  private readonly excluded: ReadonlySet<string>
  /**
   * The densest rate the provider showed for what one of this turn's steps added: the tokens it
   * counted past the call before, against the bytes the step added to that call's request.
   */
  private densestAdded: number | undefined

  constructor(private readonly input: AgentContextGuardInput) {
    this.excluded = new Set(input.excludeTools ?? [])
  }

  /**
   * The rate what a turn adds is weighed at before the provider counts it: the run's, or denser
   * once a step of this turn showed it. A result of base64 or random identifiers reads three times
   * denser than prose, and its next ones are weighed as it was counted, not as the run reads.
   */
  private get addedBytesPerToken(): number {
    return Math.min(this.bytesPerToken, this.densestAdded ?? Number.POSITIVE_INFINITY)
  }

  /**
   * Learn what the last step added weighs, from the provider's counts of the last two calls:
   * only when the last call's request kept every message of the one before it, so the difference
   * is what the step added, and when that is enough to tell (see measureAgentContextTokenRate).
   */
  private learn(steps: readonly ModelStep[]): void {
    const read = steps.at(-1)?.usage.inputTokens
    const readBefore = steps.at(-2)?.usage.inputTokens
    const sent = this.sent.get(steps.length - 1)
    const sentBefore = this.sent.get(steps.length - 2)
    if (!read || !readBefore || !sent || !sentBefore) return

    const kept = new Set(sent)
    if (sentBefore.some((message) => !kept.has(message))) return

    const before = new Set(sentBefore)
    const added = sent.filter((message) => !before.has(message))
    const size = measureAgentModelRequest({ messages: added, tools: [] })
    const bare = measureAgentModelRequest({ messages: [], tools: [] })
    const sample = measureAgentContextTokenRate({
      size: { ...size, bytes: size.bytes - bare.bytes, tokens: size.tokens - bare.tokens },
      inputTokens: read - readBefore,
    })
    if (!sample) return

    const rate = Math.max(AGENT_TOKEN_RATE_MIN_BYTES_PER_TOKEN, sample.bytes / sample.tokens)
    this.densestAdded = Math.min(this.densestAdded ?? rate, rate)
  }

  private get bytesPerToken(): number {
    return (
      this.input.measuredBytesPerToken?.() ??
      this.input.bytesPerToken ??
      this.input.budget.bytesPerToken
    )
  }

  async prepareStep({
    stepIndex,
    messages,
    steps,
    model,
  }: PrepareModelStepInput): Promise<PrepareModelStepResult | undefined> {
    this.headLength ??= messages.length
    this.learn(steps)

    const tokens = this.weighed(messages, steps)
    const reduced =
      tokens > this.input.budget.inputBudgetTokens
        ? await this.reduce(messages, steps, tokens, "threshold")
        : undefined

    this.record(stepIndex, reduced ?? messages)
    const sent = reduced ?? messages
    return this.sending(reduced, reduced ? this.weighed(sent, steps) : tokens, model, {
      heaviest: this.heaviest(sent, steps),
    })
  }

  async recoverStep({
    stepIndex,
    messages,
    steps,
    model,
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
    return this.sending(reduced, this.weighed(reduced, steps), model, {
      heaviest: this.heaviest(reduced, steps),
      askedAgain: true,
    })
  }

  /**
   * What a request weighs before the guard sends it: its projection, and a margin on the growth
   * since the last call, which the estimate may miss. The first call has none to go by: its whole
   * request is estimated, at the rate the thread measured, as its preflight weighed it.
   */
  private weighed(messages: readonly ModelMessage[], steps: readonly ModelStep[]): number {
    const { fixed, added } = this.measure(messages, steps)
    const margin = fixed > 0 ? Math.ceil(added * this.scale * GROWTH_MARGIN) : 0
    return this.projectedTokens(messages, steps) + margin
  }

  /**
   * The most a request may weigh: what the last call read, less what was removed, and what was
   * added since at one byte a token, the densest any tokenizer reads. Without a call to go by, what
   * it weighs.
   */
  private heaviest(messages: readonly ModelMessage[], steps: readonly ModelStep[]): number {
    const { fixed, removed, added } = this.measure(
      messages,
      steps,
      AGENT_TOKEN_RATE_MIN_BYTES_PER_TOKEN
    )
    return fixed > 0
      ? fixed - removed + Math.ceil(added * this.scale)
      : this.weighed(messages, steps)
  }

  /**
   * The step's request as it goes out, with the room its answer has: what its input leaves of the
   * window, the one measure the model's output ceiling sizes an answer by too (the step's
   * allowance is the smaller of the two). The guard's is the better weight: anchored on what the
   * provider counted, and at the density the turn's additions showed.
   *
   * Within the limit, the room is sized for the most the input may weigh short of the limit: what
   * the turn added since the last call, at one byte a token, so a first dense result whose density
   * the turn has not measured yet still leaves input and answer within the window. The reserve
   * stays its least, as the limit guarantees it.
   *
   * Past the limit, nothing more could be reduced: its answer gets only the room its input leaves,
   * and a request left less than an answer is worth (see agentMinimumAnswerTokens) is not sent: it
   * fails as the provider's refusal would, which ends the turn with the context error rather than a
   * call cut off at once.
   */
  private sending(
    reduced: readonly ModelMessage[] | undefined,
    tokens: number,
    model: LanguageModel,
    weight: { readonly heaviest: number; readonly askedAgain?: boolean }
  ): PrepareModelStepResult {
    const { budget } = this.input
    const messages = reduced ? { messages: reduced } : {}
    if (tokens <= budget.inputBudgetTokens) {
      const atMost = Math.max(tokens, Math.min(weight.heaviest, budget.inputBudgetTokens))
      return {
        ...messages,
        maxOutputTokens: agentOutputRoomTokens(atMost, budget, Number.POSITIVE_INFINITY),
      }
    }

    const room = agentOutputRoomTokens(tokens, budget, Number.POSITIVE_INFINITY)
    const minimum = agentMinimumAnswerTokens(budget)
    // A call the provider refused is asked again once, whatever the guard weighs it at: after a
    // refusal, what it weighs leans on the window as the least the provider counted, and the
    // provider's own count of the reduced request decides.
    if (weight.askedAgain && room < minimum) return { ...messages, maxOutputTokens: minimum }
    if (room < minimum) {
      throw new ModelProviderError(
        `[SixbAgent] The request leaves no room in the model's ${budget.windowTokens.toLocaleString("en-US")}-token context window for an answer, and nothing more of it can be cleared or summarized.`,
        model.providerId,
        model.modelId,
        { reason: "context-window-exceeded" }
      )
    }
    return { ...messages, maxOutputTokens: room }
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
        this.remember(cleared.calls)
        return cleared.messages
      }
    }

    // 2. Compacting summarizes what came before the turn; the turn stays as it is.
    let current = messages
    let currentTokens = tokens
    if (this.input.compact && !this.compacted) {
      this.compacted = true
      const head = await this.input.compact({ reason })
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
      this.remember(cleared.calls)
      current = cleared.messages
      currentTokens = this.projectedTokens(current, steps)
    }

    // Past the limit even so, the results the model has not read are cut to fit it.
    if (currentTokens > limitTokens) {
      const cut = this.cutUnread(current, currentTokens - limitTokens)
      if (cut.messages !== current) this.cleared = true
      this.remember(cut.calls)
      current = cut.messages
    }

    return current === messages ? undefined : current
  }

  /**
   * The oldest tool results the model has read, cleared until `neededTokens` are freed or only
   * the most recent {@link KEPT_TOOL_RESULTS} is left, and the calls they answered. A result the
   * model asked for again after this run cleared or cut it stays.
   */
  private clear(
    messages: readonly ModelMessage[],
    steps: readonly ModelStep[],
    neededTokens: number
  ): {
    readonly messages: readonly ModelMessage[]
    readonly tokens: number
    readonly calls: readonly ReducedCall[]
  } {
    const counted = this.countedMessages(steps)
    const calls = toolCallKeys(messages)
    const read = messages.map((message) => message.role).lastIndexOf("assistant")
    const candidates: {
      readonly message: number
      readonly part: number
      readonly gain: number
      readonly call: ReducedCall | undefined
    }[] = []
    for (const [index, message] of messages.entries()) {
      if (index >= read || message.role !== "tool") continue

      for (const [partIndex, part] of message.content.entries()) {
        const bytes = clearableBytes(part)
        if (bytes === undefined || this.excluded.has(part.toolName)) continue

        if (this.needed(calls, part.toolCallId)) continue

        const placeholder = utf8Bytes(clearedToolResultText(part.toolName))
        candidates.push({
          message: index,
          part: partIndex,
          gain: this.tokensOf(bytes - placeholder, !counted.has(message)),
          call: reducedCall(calls, part.toolCallId),
        })
      }
    }

    const chosen = new Map<number, Set<number>>()
    const chosenCalls: ReducedCall[] = []
    let tokens = 0
    for (const candidate of candidates.slice(0, -KEPT_TOOL_RESULTS)) {
      if (tokens >= neededTokens) break

      tokens += candidate.gain
      const parts = chosen.get(candidate.message) ?? new Set<number>()
      parts.add(candidate.part)
      chosen.set(candidate.message, parts)
      if (candidate.call !== undefined) chosenCalls.push(candidate.call)
    }
    if (chosen.size === 0) return { messages, tokens: 0, calls: [] }

    return {
      tokens,
      calls: chosenCalls,
      messages: replaceToolResults(messages, chosen, (part) => ({
        ...withoutOriginalOutput(part),
        output: { type: "text", value: clearedToolResultText(part.toolName) },
      })),
    }
  }

  /**
   * The results of the step the model has not read yet, each cut to the same length, halved
   * until `excessTokens` are freed: they are the turn's newest work, so the model reads what fits
   * of each and learns how to read the rest. One it asked for again after it was cleared or cut
   * stays whole: what the turn needs then does not fit, and the provider's refusal ends the turn.
   */
  private cutUnread(
    messages: readonly ModelMessage[],
    excessTokens: number
  ): { readonly messages: readonly ModelMessage[]; readonly calls: readonly ReducedCall[] } {
    const calls = toolCallKeys(messages)
    const read = messages.map((message) => message.role).lastIndexOf("assistant")
    const unread = new Map<number, Set<number>>()
    let longest = 0
    for (const [index, message] of messages.entries()) {
      if (index <= read || message.role !== "tool") continue

      for (const [partIndex, part] of message.content.entries()) {
        const bytes = clearableBytes(part)
        if (bytes === undefined) continue

        if (this.needed(calls, part.toolCallId)) continue

        longest = Math.max(longest, bytes)
        const parts = unread.get(index) ?? new Set<number>()
        parts.add(partIndex)
        unread.set(index, parts)
      }
    }

    let maxBytes = Math.floor(longest / 2)
    let cut = messages
    let cutCalls: ReducedCall[] = []
    while (maxBytes >= CUT_MIN_BYTES) {
      let freed = 0
      const limit = maxBytes
      const calledFor: ReducedCall[] = []
      cut = replaceToolResults(messages, unread, (part) => {
        const text = toolResultText(part)
        const kept = cutText(text, limit, part.toolName)
        const call = reducedCall(calls, part.toolCallId)
        if (kept !== text && call) calledFor.push(call)

        freed += this.tokensOf(utf8Bytes(text) - utf8Bytes(kept), true)
        return { ...withoutOriginalOutput(part), output: { type: "text", value: kept } }
      })
      cutCalls = calledFor
      if (freed >= excessTokens) break

      maxBytes = Math.floor(maxBytes / 2)
    }
    return { messages: cut, calls: cutCalls }
  }

  /** Remember the calls whose results were cleared or cut. */
  private remember(calls: readonly ReducedCall[]): void {
    for (const { key, toolCallId } of calls) {
      const reduced = this.reducedCalls.get(key) ?? new Set<string>()
      reduced.add(toolCallId)
      this.reducedCalls.set(key, reduced)
    }
  }

  /**
   * Whether the model asked for this result again after the run cleared or cut another's, and it
   * is the newest of its call. An older copy is superseded by the newer one: a command the model
   * runs again and again (a status it polls, a listing) leaves every copy but the last clearable.
   */
  private needed(calls: ReadonlyMap<string, string>, toolCallId: string): boolean {
    const key = calls.get(toolCallId)
    const reduced = key === undefined ? undefined : this.reducedCalls.get(key)
    if (reduced === undefined || reduced.has(toolCallId)) return false

    // In message order: the last call with the key is its newest.
    let newest: string | undefined
    for (const [id, other] of calls) {
      if (other === key) newest = id
    }
    return newest === toolCallId
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
   * keeps the ones it sends again, and a message cleared or compacted is a new one. What it adds
   * weighs at the rate what the turn adds is (see addedBytesPerToken), what it removes at the
   * run's: the provider counted it already, and subtracting too little is the safe side.
   */
  private measure(
    messages: readonly ModelMessage[],
    steps: readonly ModelStep[],
    addedBytesPerToken = this.addedBytesPerToken
  ): { readonly fixed: number; readonly removed: number; readonly added: number } {
    const read = steps.at(-1)?.usage.inputTokens
    const sent = this.sent.get(steps.length - 1)
    if (read === undefined || read <= 0 || sent === undefined) {
      return { fixed: 0, removed: 0, added: this.rawEstimate(messages) }
    }

    const before = new Set(sent)
    const after = new Set(messages)
    const weigh = (
      list: readonly ModelMessage[],
      kept: ReadonlySet<ModelMessage>,
      bytesPerToken: number
    ) =>
      list.reduce(
        (total, message) => total + (kept.has(message) ? 0 : this.weight(message, bytesPerToken)),
        0
      )
    return {
      fixed: read,
      removed: weigh(sent, after, this.bytesPerToken),
      added: weigh(messages, before, addedBytesPerToken),
    }
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

  /** One message's estimate at `bytesPerToken`, without the request's own overhead. */
  private weight(message: ModelMessage, bytesPerToken: number): number {
    return (
      estimateAgentRequestTokens({ messages: [message], tools: [] }, bytesPerToken) -
      estimateAgentRequestTokens({ messages: [], tools: [] }, bytesPerToken)
    )
  }

  /**
   * `bytes` as tokens: at the scaled rate of what the turn adds when the provider has not counted
   * them yet, else at the run's.
   */
  private tokensOf(bytes: number, added: boolean): number {
    const tokens = added
      ? (bytes / this.addedBytesPerToken) * this.scale
      : bytes / this.bytesPerToken
    return Math.max(0, Math.ceil(tokens))
  }
}

/** A call whose result was cleared or cut: what it asked, and which call it was. */
interface ReducedCall {
  readonly key: string
  readonly toolCallId: string
}

function reducedCall(
  calls: ReadonlyMap<string, string>,
  toolCallId: string
): ReducedCall | undefined {
  const key = calls.get(toolCallId)
  return key === undefined ? undefined : { key, toolCallId }
}

/** What each call in `messages` asked, by its id: its tool and its input. */
function toolCallKeys(messages: readonly ModelMessage[]): ReadonlyMap<string, string> {
  const keys = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== "assistant") continue

    for (const part of message.content) {
      if (part.type !== "tool-call") continue

      keys.set(part.toolCallId, `${part.toolName}\u0000${stableJsonStringify(part.input)}`)
    }
  }
  return keys
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
