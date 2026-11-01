import type { AgentMessagePart } from "@sixb/core"
import {
  AGENT_CONTEXT_COMPACTED_SHARE,
  AGENT_IDLE_COMPACTION_TOKENS,
  type AgentContextBudget,
  type AgentContextCompactionBoundary,
  type AgentContextEstimateTool,
  AgentExecutionLostError,
  type AgentRunSession,
  type AgentThreadModelContextMessage,
  type AgentToolSpec,
  type AgentTurnHistory,
  agentContextCheckpointId,
  contextSummaryOutputTokens,
  estimateAgentContextMessagesTokens,
  estimateAgentContextRequestTokens,
  estimateAgentThreadRequest,
  projectAgentThreadModelContext,
  runModelLoop,
  selectAgentContextCompactionBoundary,
  shouldCompactAgentContext,
} from "@sixb/core/internal/agents"
import {
  isModelCallAccountingFailure,
  modelCacheLifetimeMs,
} from "@sixb/core/internal/model-execution"
import type { OntologyDocsIndexEntry } from "@sixb/core/internal/ontology"
import type { ModelCachingIntent, ModelMessage, ModelReasoning, ModelTool } from "@sixb/core/models"
import type {
  AgentContextCheckpointReason,
  AgentContextCheckpointRecord,
  AgentMessageRecord,
  ConversationAgentRunRecord,
  SubagentRunRecord,
} from "@sixb/core/storage"
import { AgentStorageError, stableJsonStringify } from "@sixb/core/storage"
import { renderAgentSystemPrompt } from "./agent-prompt"
import type { ConversationMemory } from "./conversation-memory"
import { conversationModelSettings } from "./conversation-messages"
import { AgentContextCompactionError } from "./errors"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import {
  type ConversationReaders,
  conversationAuthors,
  conversationAuthorsText,
} from "./message-authors"
import { agentThreadModelContext, type LoadedAgentThreadModelContext } from "./thread-context"
import { agentModelToolSpecs } from "./tools/model-spec"
import type { AgentTurnRuntime } from "./turn-runtime"
import type { AgentExecutionContext } from "./types"

const SUMMARY_FORMAT_VERSION = 1 as const
const CHECKPOINT_RETRY_DELAYS_MS = [50, 200, 600] as const

/** English prose runs about this many words per token, to state the summary's length in words. */
const WORDS_PER_TOKEN = 0.75

/** How much of the message the recent work kept as it is starts from the instruction quotes. */
const KEPT_FROM_QUOTE_CHARS = 120

/** How much of each user message a summary quotes. */
const USER_MESSAGE_QUOTE_CHARS = 300

const HISTORY_POINTER = "`sixb history` prints the earlier conversation."

/** What the message that carries a summary adds to it: its opening sentence and tags. */
const SUMMARY_HEADER_TOKENS = 64

/** A turn cut to fit the summary request keeps at least this much of each text and result. */
const SHRUNK_PART_MIN_BYTES = 1_024

/** What a turn's model calls start with: the prefix a summary of the conversation continues. */
export interface ConversationRequest {
  readonly systemPrompt: string
  readonly tools: readonly Pick<ModelTool, "name" | "description" | "inputSchema">[]
  readonly messages: readonly ModelMessage[]
}

/**
 * The request a turn's calls send for a history, built as the run's environment and its turn
 * build it, with the memory its prompt shows.
 */
export type BuildConversationRequest = (input: {
  readonly threadContext: LoadedAgentThreadModelContext
  readonly memory: ConversationMemory | undefined
}) => Promise<ConversationRequest>

export interface PreparedAgentConversationContext {
  readonly threadContext: LoadedAgentThreadModelContext
  /** The memory the run's prompt shows, as of the active checkpoint. */
  readonly memory?: ConversationMemory
  /** The bytes per token the turn's history was measured at, when the preflight measured it. */
  readonly bytesPerToken?: number
}

/** Memory as of a checkpoint's creation, or of the thread's start when there is none. */
export type LoadConversationMemory = (
  checkpoint: { readonly createdAt: Date } | null
) => Promise<ConversationMemory | undefined>

/** What a request carries besides its history, as an estimate counts it. */
export interface AgentContextEstimateShape {
  readonly systemPrompt: string
  readonly tools: readonly AgentContextEstimateTool[]
  /** Messages every request sends ahead of the history: a child's task, once summarized. */
  readonly head?: readonly AgentThreadModelContextMessage[]
}

/** What a request of this shape weighs with `messages` as its history. */
function estimateShapedRequest(
  shape: AgentContextEstimateShape,
  messages: readonly AgentThreadModelContextMessage[],
  bytesPerToken: number
) {
  return estimateAgentContextRequestTokens({
    systemPrompt: shape.systemPrompt,
    tools: shape.tools,
    messages: [...(shape.head ?? []), ...messages],
    bytesPerToken,
  })
}

/**
 * What a thread's compaction reads and writes through, before a run or during it: a
 * conversation's, or a child's, whose thread is its history.
 */
export interface AgentThreadCompactionInput {
  readonly context: Pick<AgentExecutionContext, "id">
  /** The run's session: its history, the checkpoint it writes, and the records it publishes. */
  readonly session: AgentRunSession
  readonly plan: ResolvedAgentExecutionPlan
  readonly budget: AgentContextBudget
  readonly run: ConversationAgentRunRecord | SubagentRunRecord
  readonly runtime: AgentTurnRuntime
  readonly loadMemory?: LoadConversationMemory
  /** The request the run would send for a history: what its summary continues. */
  readonly conversationRequest: BuildConversationRequest
  /** What the run's requests carry besides a history, with the memory its prompt shows. */
  readonly estimateShape: (
    threadContext: LoadedAgentThreadModelContext,
    memory: ConversationMemory | undefined
  ) => AgentContextEstimateShape
  /** How the run's calls are cached: the summary is read as their continuation. */
  readonly caching: ModelCachingIntent
}

/** What a conversation's compaction reads and writes through, before its turn or during it. */
interface ConversationCompactionInput
  extends Omit<AgentThreadCompactionInput, "context" | "run" | "estimateShape" | "caching"> {
  readonly context: AgentExecutionContext
  readonly run: ConversationAgentRunRecord
  /** The ontology files listed in the conversation's prompt. */
  readonly ontologyIndex?: readonly OntologyDocsIndexEntry[]
  /** Where the run's files go, as the prompt names them. */
  readonly contextDirectory: string
  /** Who can read the run's thread: in a shared one, who wrote what counts toward the estimate. */
  readonly conversation?: ConversationReaders
  readonly frameworkTools?: readonly ModelTool[]
}

/** Load, estimate, and—when required—compact one admitted conversational run before setup. */
export async function prepareAgentConversationContext(
  input: ConversationCompactionInput & {
    /** The conversation's history as the turn started. */
    readonly history: AgentTurnHistory
  }
): Promise<PreparedAgentConversationContext> {
  const { plan, budget, run, runtime } = input
  const compaction = conversationCompaction(input)
  const initialContext = agentThreadModelContext(input.history)
  const memory = await input.loadMemory?.(initialContext.checkpoint)
  runtime.assertCanContinue()

  const estimateShape = conversationEstimateShape(input, initialContext, memory)
  const { tokens: estimatedInputTokensBefore, bytesPerToken } = estimateAgentConversation({
    plan,
    budget,
    threadContext: initialContext,
    ...estimateShape,
  })
  runtime.assertCanContinue()

  const unchanged = { threadContext: initialContext, ...(memory ? { memory } : {}), bytesPerToken }
  const overLimit = shouldCompactAgentContext({
    estimatedInputTokens: estimatedInputTokensBefore,
    inputBudgetTokens: budget.inputBudgetTokens,
  })

  // Compaction aims well under the limit, so the turns after it grow into the room it leaves
  // instead of compacting again: the system prompt and tools, the summary at its longest, and the
  // recent work that fits the rest.
  const summaryTokens = contextSummaryTextTokens(plan, budget)
  const summaryMessageTokens = summaryTokens + SUMMARY_HEADER_TOKENS
  const fixedTokens = estimateShapedRequest(estimateShape, [], bytesPerToken).tokens
  const aimTokens = Math.floor(budget.inputBudgetTokens * AGENT_CONTEXT_COMPACTED_SHARE)

  // This run's own checkpoint is already as compact as it gets.
  const ownCheckpoint = initialContext.checkpoint?.createdByRunId === run.id
  const boundary = ownCheckpoint
    ? null
    : selectAgentContextCompactionBoundary({
        messages: initialContext.retainedMessages,
        keepRecentTokens: Math.max(
          0,
          Math.min(budget.keepRecentTokens, aimTokens - fixedTokens - summaryMessageTokens)
        ),
        bytesPerToken,
      })

  const idle =
    !overLimit &&
    shouldCompactIdleContext({
      history: input.history,
      caching: compaction.caching,
      estimatedInputTokens: estimatedInputTokensBefore,
      compactedTokens: compactedRequestTokens({
        fixedTokens,
        summaryMessageTokens,
        boundary,
        bytesPerToken,
      }),
    })
  if (!overLimit && !idle) return unchanged

  try {
    const compacted = await compactAgentConversation({
      ...compaction,
      threadContext: initialContext,
      memory,
      bytesPerToken,
      reason: "threshold",
      boundary,
      ownCheckpoint,
      estimatedInputTokensBefore,
      // Below the limit, the thread compacts because it is idle: its cache has gone cold.
      coldCache: !overLimit,
    })
    return { ...compacted, bytesPerToken }
  } catch (error) {
    if (overLimit || !(error instanceof AgentContextCompactionError)) throw error

    // Below the limit, a failed idle compaction leaves the turn as it was.
    console.warn(`[SixbAgent] Run '${run.id}' goes on uncompacted: ${error.message}`, error)
    return unchanged
  }
}

/** What compacting a thread from within the run in flight is given. */
interface InRunCompaction {
  /** The history the run works on: as it started, or as its compaction left it. */
  readonly threadContext: LoadedAgentThreadModelContext
  /** The memory the run's prompt shows. */
  readonly memory: ConversationMemory | undefined
  readonly reason: AgentContextCheckpointReason
  /** Whether the thread came back idle, its cache expired: see summarize. */
  readonly coldCache: boolean
}

/**
 * Compact the conversation before the turn in flight, from within it: everything before the
 * turn's own message is summarized, and the turn, its message and the steps it has taken, stays
 * as it is. Undefined when there is nothing before the turn to summarize, when the run already
 * compacted the thread (a run writes one checkpoint), or when the compaction failed: the turn
 * then goes on with what it has.
 */
export function compactAgentConversationInTurn(
  input: ConversationCompactionInput & InRunCompaction
): Promise<PreparedAgentConversationContext | undefined> {
  return compactAgentThreadInRun({ ...input, ...conversationCompaction(input) })
}

/**
 * Compact a thread before the run in flight, from within it: everything before the message the
 * run started from is summarized, and that message and the steps it took stay as they are. A
 * conversation's turn, or a child continuing its thread. Undefined as for
 * {@link compactAgentConversationInTurn}.
 *
 * Its estimates before and after weigh the same request, the history with the run's message,
 * without the steps it keeps: what the summary replaced, not what the run is about to send.
 */
export async function compactAgentThreadInRun(
  input: AgentThreadCompactionInput & InRunCompaction
): Promise<PreparedAgentConversationContext | undefined> {
  const { threadContext, run } = input
  if (threadContext.checkpoint?.createdByRunId === run.id) return undefined

  const estimateShape = input.estimateShape(threadContext, input.memory)
  const { tokens, bytesPerToken } = estimateAgentConversation({
    plan: input.plan,
    budget: input.budget,
    threadContext,
    ...estimateShape,
  })
  const boundary = inRunBoundary(threadContext, bytesPerToken)
  if (!boundary) return undefined

  // A summary at its longest weighs as much as an earlier history this short: nothing to gain.
  const summarizedTokens = estimateAgentContextMessagesTokens(
    threadContext.modelMessages.slice(
      0,
      threadContext.modelMessages.length - boundary.retainedMessages.length
    ),
    bytesPerToken
  ).tokens
  if (
    summarizedTokens <=
    contextSummaryTextTokens(input.plan, input.budget) + SUMMARY_HEADER_TOKENS
  ) {
    return undefined
  }

  try {
    return await compactAgentConversation({
      ...input,
      bytesPerToken,
      boundary,
      ownCheckpoint: false,
      estimatedInputTokensBefore: tokens,
      coldCache: input.coldCache,
    })
  } catch (error) {
    if (!(error instanceof AgentContextCompactionError)) throw error

    console.warn(`[SixbAgent] Run '${run.id}' goes on uncompacted: ${error.message}`, error)
    return undefined
  }
}

/** A conversation's compaction as any thread's: its estimate's prompt, and its turns' caching. */
function conversationCompaction(input: ConversationCompactionInput): AgentThreadCompactionInput {
  return {
    ...input,
    estimateShape: (threadContext, memory) =>
      conversationEstimateShape(input, threadContext, memory),
    caching: conversationModelSettings({
      reasoning: undefined,
      projectId: input.context.id,
      threadId: input.run.threadId,
    }).caching,
  }
}

/** The system prompt and tools a conversation's estimate counts, with the memory its prompt shows. */
function conversationEstimateShape(
  input: ConversationCompactionInput,
  threadContext: LoadedAgentThreadModelContext,
  memory: ConversationMemory | undefined
): AgentContextEstimateShape {
  const { context, plan } = input

  // Who takes part is in the system prompt, and each message's author on it.
  const authors = input.conversation
    ? conversationAuthors({
        conversation: input.conversation,
        messages: threadContext.retainedMessages,
      })
    : undefined

  return {
    systemPrompt: [
      renderAgentSystemPrompt({
        mode: "conversation",
        contextDirectory: input.contextDirectory,
        instructions: plan.instructions,
        skills: plan.skills,
        ...(input.ontologyIndex === undefined ? {} : { ontologyIndex: input.ontologyIndex }),
        facts: context.requester === undefined ? {} : { requester: context.requester },
        ...(authors?.section === undefined ? {} : { conversation: authors.section }),
        ...(plan.sandboxModels ? { sandboxModels: plan.sandboxModels } : {}),
        ...(memory ? { memory: memory.prompt } : {}),
      }),
      authors ? conversationAuthorsText(authors) : "",
    ].join("\n"),
    tools: contextEstimateTools([
      ...agentModelToolSpecs(plan.tools),
      ...(input.frameworkTools ?? []),
    ]),
  }
}

/**
 * Summarize the conversation up to `boundary` into a checkpoint, and answer the history from it
 * with the memory its prompt now shows. Publishes the compaction's start and end; throws an
 * {@link AgentContextCompactionError} when it cannot compact, and lost ownership, cancellation or
 * the summary call's own accounting failure as they are.
 */
async function compactAgentConversation(
  input: AgentThreadCompactionInput & {
    readonly threadContext: LoadedAgentThreadModelContext
    readonly memory: ConversationMemory | undefined
    readonly bytesPerToken: number
    readonly reason: AgentContextCheckpointReason
    readonly boundary: AgentContextCompactionBoundary | null
    readonly ownCheckpoint: boolean
    readonly estimatedInputTokensBefore: number
    /** Whether the conversation's cache has expired: see summarize. */
    readonly coldCache: boolean
  }
): Promise<PreparedAgentConversationContext> {
  const { context, session, plan, budget, run, runtime, reason, boundary, bytesPerToken } = input
  const { estimatedInputTokensBefore, memory } = input
  const initialContext = input.threadContext
  const estimateShape = input.estimateShape(initialContext, memory)
  const summaryTokens = contextSummaryTextTokens(plan, budget)

  await session.events.publishCompactionStarted({
    run,
    reason,
    estimatedInputTokensBefore,
  })

  try {
    if (input.ownCheckpoint) {
      throw new AgentContextCompactionError(
        "context_limit_exceeded",
        run.id,
        "The current run already compacted this thread, but its retained context still exceeds the model input budget."
      )
    }
    if (!boundary) {
      throw new AgentContextCompactionError(
        "context_limit_exceeded",
        run.id,
        "The current request exceeds the model input budget and no older complete turn can be removed."
      )
    }

    // Only a conversation's turn can print its thread's stored messages: what a summary says of them.
    const historyReadable = run.kind === "conversation"
    const checkpointId = agentContextCheckpointId(run.id)
    const observedHeadSeq = requiredHeadSeq(initialContext.retainedMessages, run)
    const candidateBase: AgentContextCheckpointRecord = {
      id: checkpointId,
      projectId: context.id,
      threadId: run.threadId,
      createdByRunId: run.id,
      ...(initialContext.checkpoint ? { previousCheckpointId: initialContext.checkpoint.id } : {}),
      reason,
      // Project a minimal summary to reject an oversized retained tail before a billable call.
      summary: ".",
      summaryFormatVersion: SUMMARY_FORMAT_VERSION,
      summarizedThroughSeq: boundary.summarizedThroughSeq,
      observedHeadSeq,
      estimatedInputTokensBefore,
      estimatedInputTokensAfter: 0,
      summaryModelId: plan.model.modelId,
      createdAt: new Date(),
    }
    // The continuation's prompt shows memory as of the new checkpoint.
    const compactedMemory = await input.loadMemory?.(candidateBase)
    runtime.assertCanContinue()
    const compactedShape = input.estimateShape(initialContext, compactedMemory)
    const minimumContinuationTokens = estimateShapedRequest(
      compactedShape,
      projectAgentThreadModelContext({
        checkpoint: candidateBase,
        messages: boundary.retainedMessages,
        historyReadable,
      }),
      bytesPerToken
    ).tokens
    if (minimumContinuationTokens >= budget.inputBudgetTokens) {
      throw new AgentContextCompactionError(
        "context_limit_exceeded",
        run.id,
        "The retained turn and tools leave no room for a context summary. Start a new conversation or select a model with a larger context window."
      )
    }

    // The summary request leaves the window room for the summary, and for a reasoning budget the
    // provider requires below the output limit. A history whose turns cleared tool results replays
    // them whole, a prefix no call sent and no provider cached: its summary reads it in steps under
    // the model's limit, rather than all of it at once.
    const { requiredTokens } = summaryReasoning(plan.reasoning, summaryTokens)
    const replaysReduced = initialContext.retainedMessages.some((message) =>
      message.parts.some((part) => part.type === "step-start" && part.reducedRequest)
    )
    const steps = planSummary({
      threadContext: initialContext,
      boundary,
      estimateShape,
      bytesPerToken,
      summaryTokens,
      historyReadable,
      inputLimitTokens: Math.min(
        plan.model.definition.maxInputTokens ?? Number.POSITIVE_INFINITY,
        budget.windowTokens - summaryTokens - requiredTokens,
        replaysReduced ? budget.inputBudgetTokens : Number.POSITIVE_INFINITY
      ),
    })
    if (!steps) {
      throw new AgentContextCompactionError(
        "context_limit_exceeded",
        run.id,
        "The earlier history exceeds the selected model's summary input budget. Select a model with a larger context window or start a new conversation."
      )
    }

    const summary = await generateCheckpointSummary({
      plan,
      budget,
      run,
      runtime,
      threadContext: initialContext,
      steps,
      stepCheckpoint: (summary, messages) => ({
        ...candidateBase,
        summary,
        summarizedThroughSeq: messages[0]!.seq - 1,
        observedHeadSeq: messages.at(-1)!.seq,
      }),
      memory,
      conversationRequest: input.conversationRequest,
      caching: input.caching,
      bytesPerToken,
      summaryTokens: Math.min(summaryTokens, budget.inputBudgetTokens - minimumContinuationTokens),
      coldCache: input.coldCache,
      historyReadable,
    })
    runtime.assertCanContinue()
    const candidate = { ...candidateBase, summary }
    const estimatedInputTokensAfter = estimateShapedRequest(
      compactedShape,
      projectAgentThreadModelContext({
        checkpoint: candidate,
        messages: boundary.retainedMessages,
        historyReadable,
      }),
      bytesPerToken
    ).tokens
    if (estimatedInputTokensAfter > budget.inputBudgetTokens) {
      throw new AgentContextCompactionError(
        "context_limit_exceeded",
        run.id,
        "The summary and selected recent tail still exceed the model input budget. Start a new conversation or select a model with a larger context window."
      )
    }

    const threadContext = agentThreadModelContext(
      await createCheckpoint({
        session,
        runtime,
        run,
        candidate,
        estimatedInputTokensAfter,
        expectedPreviousCheckpointId: initialContext.checkpoint?.id ?? null,
      }),
      { historyReadable }
    )
    runtime.assertCanContinue()
    const checkpoint = candidate
    if (threadContext.checkpoint?.id !== checkpoint.id) {
      throw new AgentContextCompactionError(
        "checkpoint_failed",
        run.id,
        `Context checkpoint '${checkpoint.id}' was not the active checkpoint after creation.`
      )
    }

    await session.events.publishCompactionCompleted({
      run,
      reason,
      checkpointId: checkpoint.id,
      estimatedInputTokensBefore,
      estimatedInputTokensAfter,
    })
    return { threadContext, ...(compactedMemory ? { memory: compactedMemory } : {}) }
  } catch (error) {
    // Preserve lost ownership, cancellation and the model call's own accounting failure as their
    // original run-level outcome instead of relabeling them as a compaction implementation failure.
    runtime.assertCanContinue()
    const compactionError = normalizeCompactionError(error, run.id)
    await session.events.publishCompactionFailed({
      run,
      reason,
      errorCode: compactionError.code,
    })
    throw compactionError
  }
}

/**
 * Whether a run starts on a thread worth compacting though it fits: its last model call is older
 * than the cache its calls ask for, so the next one rewrites the whole prompt anyway, the prompt
 * is large enough for a summary to make that rewrite much smaller, and compacting brings it under
 * that size, rather than summarize at every idle turn. A thread whose last call the session cannot
 * date (none since its checkpoint) is not compacted for it.
 */
export function shouldCompactIdleContext(input: {
  readonly history: AgentTurnHistory
  readonly caching: ModelCachingIntent
  readonly estimatedInputTokens: number
  /** What the next request weighs once compacted: see compactedRequestTokens. */
  readonly compactedTokens: number
}): boolean {
  const lastCall = input.history.usageAnchor?.modelCall.occurredAt
  if (!lastCall || input.estimatedInputTokens < AGENT_IDLE_COMPACTION_TOKENS) return false
  if (Date.now() - lastCall.getTime() <= modelCacheLifetimeMs(input.caching.lifetime)) return false

  return input.compactedTokens < AGENT_IDLE_COMPACTION_TOKENS
}

/** Where a compaction from within a run cuts: the run's own message starts what stays. */
function inRunBoundary(
  threadContext: LoadedAgentThreadModelContext,
  bytesPerToken: number
): AgentContextCompactionBoundary | null {
  // Its steps are not stored yet.
  return selectAgentContextCompactionBoundary({
    messages: threadContext.retainedMessages,
    keepRecentTokens: 0,
    bytesPerToken,
  })
}

/** What a thread weighs once compacted from within its run (see compactAgentThreadInRun). */
export function inRunCompactedTokens(input: {
  readonly plan: ResolvedAgentExecutionPlan
  readonly budget: AgentContextBudget
  readonly threadContext: LoadedAgentThreadModelContext
  readonly estimateShape: AgentContextEstimateShape
  readonly bytesPerToken: number
}): number {
  const { threadContext, bytesPerToken } = input
  return compactedRequestTokens({
    fixedTokens: estimateShapedRequest(input.estimateShape, [], bytesPerToken).tokens,
    summaryMessageTokens:
      contextSummaryTextTokens(input.plan, input.budget) + SUMMARY_HEADER_TOKENS,
    boundary: inRunBoundary(threadContext, bytesPerToken),
    bytesPerToken,
  })
}

/**
 * What the next request weighs once compacted at `boundary`: what it carries besides its history,
 * the summary at its longest, and the messages that stay. Without a boundary, nothing can be.
 */
function compactedRequestTokens(input: {
  readonly fixedTokens: number
  readonly summaryMessageTokens: number
  readonly boundary: AgentContextCompactionBoundary | null
  readonly bytesPerToken: number
}): number {
  if (!input.boundary) return Number.POSITIVE_INFINITY

  return (
    input.fixedTokens +
    input.summaryMessageTokens +
    estimateAgentContextMessagesTokens(input.boundary.retainedMessages, input.bytesPerToken).tokens
  )
}

/**
 * The conversation's next request as the model will count it, and the bytes per token it was
 * counted at (see estimateAgentThreadRequest): the run's history, at the rate its run started
 * from, with the system prompt and tools its requests send.
 */
export function estimateAgentConversation(
  input: AgentContextEstimateShape & {
    readonly plan: ResolvedAgentExecutionPlan
    readonly budget: AgentContextBudget
    readonly threadContext: LoadedAgentThreadModelContext
  }
): { readonly tokens: number; readonly bytesPerToken: number } {
  const { threadContext } = input
  return estimateAgentThreadRequest({
    usageAnchor: threadContext.history.usageAnchor,
    retainedMessages: threadContext.retainedMessages,
    modelMessages: threadContext.modelMessages,
    model: input.plan.model,
    bytesPerToken: input.budget.bytesPerToken,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    ...(input.head ? { head: input.head } : {}),
  })
}

/** Tools as an estimate counts them: their schemas serialized as they are sent. */
export function contextEstimateTools(
  specs: readonly Pick<AgentToolSpec, "name" | "description" | "inputSchema">[]
): readonly AgentContextEstimateTool[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: stableJsonStringify(spec.inputSchema),
  }))
}

/**
 * Write the checkpoint's summary as the continuation of the conversation's cached prompt: the
 * request the turn before this one sent, from the same model with the same system prompt, tools,
 * reasoning and cache intent, then one instruction. The provider reads that prefix from its cache
 * instead of a one-shot transcript at the full price, and the summary rewrites the earlier one it
 * reads there instead of growing from it.
 *
 * A history too long for the model to read at once is summarized in several calls, oldest first,
 * each continuing from the summary the one before wrote.
 */
async function generateCheckpointSummary(input: {
  readonly plan: ResolvedAgentExecutionPlan
  readonly budget: AgentContextBudget
  readonly run: ConversationAgentRunRecord | SubagentRunRecord
  readonly runtime: AgentTurnRuntime
  /** The history as the turn started, before compaction. */
  readonly threadContext: LoadedAgentThreadModelContext
  readonly steps: readonly SummaryStep[]
  /** The checkpoint a step after the first reads its summary from. */
  readonly stepCheckpoint: (
    summary: string,
    messages: readonly AgentMessageRecord[]
  ) => AgentContextCheckpointRecord
  /** The memory the history's prompt shows: as of its checkpoint, not the new one. */
  readonly memory: ConversationMemory | undefined
  readonly conversationRequest: BuildConversationRequest
  readonly caching: ModelCachingIntent
  readonly bytesPerToken: number
  /** The longest summary the continuation has room for. */
  readonly summaryTokens: number
  /** Whether the conversation's cache has expired: see summarize. */
  readonly coldCache: boolean
  /** Whether the run can print the thread's stored messages, for the summary to say so. */
  readonly historyReadable: boolean
}): Promise<string> {
  const { threadContext, summaryTokens, historyReadable } = input
  const retained = threadContext.retainedMessages
  const offset = threadContext.modelMessages.length - retained.length
  const maxBytes = Math.floor(summaryTokens * input.bytesPerToken)

  let summary = threadContext.checkpoint?.summary
  for (const [index, step] of input.steps.entries()) {
    const messages = step.messages ?? retained.slice(step.start, step.end)
    // The first step reads the history as the turn started; each later one, the summary so far.
    const modelMessages =
      index === 0 && !step.messages
        ? threadContext.modelMessages.slice(0, offset + step.end)
        : summary === undefined
          ? messages
          : projectAgentThreadModelContext({
              checkpoint: input.stepCheckpoint(summary, messages),
              messages,
              historyReadable,
            })
    let request: ConversationRequest
    try {
      request = await input.conversationRequest({
        threadContext: { ...threadContext, retainedMessages: messages, modelMessages },
        memory: input.memory,
      })
    } catch (error) {
      throw new ConversationRequestFailure(error)
    }
    input.runtime.assertCanContinue()

    const text = await summarize({
      plan: input.plan,
      budget: input.budget,
      run: input.run,
      runtime: input.runtime,
      request,
      caching: input.caching,
      instruction: summaryInstruction({
        summaryTokens,
        ...(step.keptFrom ? { keptFrom: step.keptFrom } : {}),
      }),
      estimatedInputTokens: step.estimatedInputTokens,
      summaryTokens,
      coldCache: input.coldCache,
    })
    summary =
      text.output.length === 0
        ? userMessagesSummary({ previous: summary, messages, maxBytes, historyReadable })
        : // A summary the output limit cut short, or longer than the room it has, is kept up to
          // its last complete line: the thread goes on from it instead of failing every turn.
          text.cut || utf8Bytes(text.output) > maxBytes
          ? cutSummary(text.output, maxBytes, historyReadable)
          : text.output
  }

  // A plan always has a step.
  return summary!
}

/** One summary call: the conversation's request, then the instruction. */
async function summarize(input: {
  readonly plan: ResolvedAgentExecutionPlan
  readonly budget: AgentContextBudget
  readonly run: ConversationAgentRunRecord | SubagentRunRecord
  readonly runtime: AgentTurnRuntime
  readonly request: ConversationRequest
  /** The run's own: the summary continues what its calls cached. */
  readonly caching: ModelCachingIntent
  readonly instruction: string
  readonly estimatedInputTokens: number
  readonly summaryTokens: number
  /**
   * Whether the conversation's cache has expired. The summary then reads the history at the full
   * price either way, and the next request starts from it: caching the history would only write
   * it, at the long cache's price.
   */
  readonly coldCache: boolean
}): Promise<{ readonly output: string; readonly cut: boolean }> {
  const { plan, budget, run, request, summaryTokens } = input
  const reasoning = summaryReasoning(plan.reasoning, summaryTokens)
  const maxOutputTokens = Math.max(
    summaryTokens,
    Math.min(
      summaryTokens + reasoning.allowanceTokens,
      budget.windowTokens - input.estimatedInputTokens,
      plan.model.definition.maxOutputTokens ?? Number.POSITIVE_INFINITY
    )
  )

  let result: Awaited<ReturnType<typeof runModelLoop<string>>>
  try {
    result = await runModelLoop({
      model: plan.model,
      messages: [
        { role: "system", content: request.systemPrompt },
        ...request.messages,
        { role: "user", content: [{ type: "text", text: input.instruction }] },
      ],
      tools: request.tools.map(summaryTool),
      ...(reasoning.reasoning === undefined ? {} : { reasoning: reasoning.reasoning }),
      caching: input.coldCache ? "off" : input.caching,
      maxSteps: 1,
      maxOutputTokens,
      signal: input.runtime.signal,
    })
  } catch (error) {
    input.runtime.assertCanContinue()
    // The summary's own model call was refused or left unrecorded: that ends the run as it is.
    if (isModelCallAccountingFailure(error)) throw error
    throw new AgentContextCompactionError(
      "summary_failed",
      run.id,
      "Could not generate a complete context summary.",
      { cause: error }
    )
  }
  input.runtime.assertCanContinue()

  if (result.status === "aborted") {
    throw new AgentContextCompactionError("summary_failed", run.id, "Context summary was aborted.")
  }

  // An answer that calls a tool, as to read the history first, holds only its preamble.
  const calledTool = result.steps.some((step) =>
    step.content.some((part) => part.type === "tool-call")
  )
  if (calledTool) return { output: "", cut: false }

  return { output: result.output.trim(), cut: result.finishReason === "length" }
}

/** One summary call: the retained messages it reads, from `start` to before `end`. */
interface SummaryStep {
  readonly start: number
  readonly end: number
  /** The message the recent work kept as it is starts from, when the step reads past it. */
  readonly keptFrom?: AgentMessageRecord
  /** A turn too large to read whole, cut to fit: read in place of its stored messages. */
  readonly messages?: readonly AgentMessageRecord[]
  readonly estimatedInputTokens: number
}

/**
 * What the summary reads. First the whole conversation before the turn: the request the turn's
 * last call sent, which the provider cached. Then only what compaction removes. A history the
 * model's window cannot read at once (a smaller model took over, or a turn outgrew the window)
 * is read in several steps, oldest first, each as many turns as fit beside the summary so far.
 * Undefined when even one turn does not fit.
 */
function planSummary(input: {
  readonly threadContext: LoadedAgentThreadModelContext
  readonly boundary: AgentContextCompactionBoundary
  readonly estimateShape: AgentContextEstimateShape
  readonly bytesPerToken: number
  readonly summaryTokens: number
  /** Whether the run can print the thread's stored messages, for a turn cut short to say so. */
  readonly historyReadable: boolean
  /** The most a summary request may read. */
  readonly inputLimitTokens: number
}): readonly SummaryStep[] | undefined {
  const { threadContext, bytesPerToken, summaryTokens } = input
  const retained = threadContext.retainedMessages
  const offset = threadContext.modelMessages.length - retained.length
  const keptFrom = retained.length - input.boundary.retainedMessages.length
  // The turn being answered stays out: what comes before it is the request its last call sent.
  const turnStart = retained.map((message) => message.role).lastIndexOf("user")

  // Messages weigh the same alone as together: each one's attachments have their own budget.
  const weights = [0]
  for (const message of threadContext.modelMessages) {
    weights.push(
      weights.at(-1)! + estimateAgentContextMessagesTokens([message], bytesPerToken).tokens
    )
  }
  const instructionTokens = (keptFrom?: AgentMessageRecord) =>
    estimateShapedRequest(
      input.estimateShape,
      [
        {
          role: "user",
          parts: [
            {
              type: "text",
              text: summaryInstruction({ summaryTokens, ...(keptFrom ? { keptFrom } : {}) }),
            },
          ],
        },
      ],
      bytesPerToken
    ).tokens
  // A later step reads the summary so far in place of the earlier summary and turns.
  const requestTokens = (start: number, end: number, keptFrom?: AgentMessageRecord) =>
    instructionTokens(keptFrom) +
    (start === 0 ? weights[offset]! : summaryTokens + SUMMARY_HEADER_TOKENS) +
    weights[offset + end]! -
    weights[offset + start]!

  for (const end of new Set([turnStart, keptFrom])) {
    const step = {
      start: 0,
      end,
      ...(end > keptFrom ? { keptFrom: retained[keptFrom]! } : {}),
    }
    const estimatedInputTokens = requestTokens(step.start, step.end, step.keptFrom)
    if (estimatedInputTokens <= input.inputLimitTokens) return [{ ...step, estimatedInputTokens }]
  }

  const steps: SummaryStep[] = []
  for (let start = 0; start < keptFrom; start = steps.at(-1)!.end) {
    let step: SummaryStep | undefined
    let nextTurn = keptFrom
    for (let end = keptFrom; end > start && !step; end -= 1) {
      if (retained[end]?.role !== "user") continue

      nextTurn = end
      const estimatedInputTokens = requestTokens(start, end)
      if (estimatedInputTokens <= input.inputLimitTokens) {
        step = { start, end, estimatedInputTokens }
      }
    }

    // Even one turn does not fit: it is read with its longest texts and results cut.
    step ??= shrunkStep({
      start,
      end: nextTurn,
      messages: retained.slice(start, nextTurn),
      // What the request reads besides the turn: the prompt, the summary so far, the instruction.
      baseTokens: requestTokens(start, start),
      inputLimitTokens: input.inputLimitTokens,
      bytesPerToken,
      historyReadable: input.historyReadable,
    })
    if (!step) return undefined

    steps.push(step)
  }
  return steps
}

/**
 * A step over one turn too large to read whole: its texts and tool results cut, the longest first,
 * until the request fits. Undefined when even cut short it does not.
 */
function shrunkStep(input: {
  readonly start: number
  readonly end: number
  readonly messages: readonly AgentMessageRecord[]
  /** What the request reads besides the turn. */
  readonly baseTokens: number
  readonly inputLimitTokens: number
  readonly bytesPerToken: number
  readonly historyReadable: boolean
}): SummaryStep | undefined {
  const longest = Math.max(
    0,
    ...input.messages.flatMap((message) => message.parts.map((part) => partBytes(part)))
  )

  for (
    let maxBytes = Math.floor(longest / 2);
    maxBytes >= SHRUNK_PART_MIN_BYTES;
    maxBytes = Math.floor(maxBytes / 2)
  ) {
    const messages = input.messages.map((message) => ({
      ...message,
      parts: message.parts.map((part) =>
        cutPart(part, maxBytes, input.historyReadable ? message.seq : undefined)
      ),
    }))
    const estimatedInputTokens =
      input.baseTokens + estimateAgentContextMessagesTokens(messages, input.bytesPerToken).tokens
    if (estimatedInputTokens <= input.inputLimitTokens) {
      return { start: input.start, end: input.end, messages, estimatedInputTokens }
    }
  }
  return undefined
}

/** What a part weighs in the request: its text, or its call's input and what the model read. */
function partBytes(part: AgentMessagePart): number {
  switch (part.type) {
    case "text":
    case "reasoning":
      return utf8Bytes(part.text)
    case "tool-call":
      return utf8Bytes(stableJsonStringify(part.input)) + utf8Bytes(toolOutputText(part))
    default:
      return 0
  }
}

/**
 * A text or tool result cut to `maxBytes`, saying where the whole is when the run can read it: the
 * message `seq` its history prints.
 */
function cutPart(
  part: AgentMessagePart,
  maxBytes: number,
  seq: number | undefined
): AgentMessagePart {
  const note =
    seq === undefined ? "[Cut short.]" : `[Cut short: \`sixb history ${seq}\` prints it whole.]`
  const cut = (value: string) =>
    utf8Bytes(value) <= maxBytes ? value : `${upToLastLine(value, maxBytes)}\n${note}`

  switch (part.type) {
    case "text":
    case "reasoning":
      return { ...part, text: cut(part.text) }
    case "tool-call":
      if (part.state === "output-error") return { ...part, errorText: cut(part.errorText) }
      return { ...part, modelOutput: { type: "text", value: cut(toolOutputText(part)) } }
    default:
      return part
  }
}

/** What the model reads of a call's result: the output its tool projected, else the output. */
function toolOutputText(part: Extract<AgentMessagePart, { readonly type: "tool-call" }>): string {
  if (part.state === "output-error") return part.errorText
  if (part.modelOutput?.type === "text") return part.modelOutput.value
  return stableJsonStringify(part.modelOutput ? part.modelOutput.value : part.output)
}

/** The summary's own allowance, apart from any reasoning: half the output reserve, at most 8,192. */
function contextSummaryTextTokens(
  plan: ResolvedAgentExecutionPlan,
  budget: AgentContextBudget
): number {
  return Math.min(
    contextSummaryOutputTokens(budget.reserveTokens),
    plan.model.definition.maxOutputTokens ?? Number.POSITIVE_INFINITY
  )
}

/**
 * How the summary call reasons, and the output it may spend on that on top of the summary. It
 * reasons as the turn's calls do: thinking and effort are part of the prefix a provider caches,
 * so a summary that changed them would read the conversation again at the full price (measured
 * through the Gateway on Haiku 5.5: 17,359 tokens read with the turn's settings, 8,928 without its
 * thinking, none with reasoning off as well).
 *
 * To summarize without thinking instead, return `reasoning: "none"` and no allowance here, and
 * leave out the binding's own thinking option as well: on the Gateway, `"none"` keeps it.
 */
function summaryReasoning(
  reasoning: ModelReasoning | undefined,
  summaryTokens: number
): {
  readonly reasoning: ModelReasoning | undefined
  readonly allowanceTokens: number
  /** What the output limit must hold whatever the window: a budget providers reject beyond it. */
  readonly requiredTokens: number
} {
  if (reasoning === "none") return { reasoning, allowanceTokens: 0, requiredTokens: 0 }
  if (typeof reasoning === "object") {
    return {
      reasoning,
      allowanceTokens: reasoning.budgetTokens,
      requiredTokens: reasoning.budgetTokens,
    }
  }

  // An effort, or the binding's own default: it may think as long as it writes, and writes less
  // when the window leaves it less.
  return { reasoning, allowanceTokens: summaryTokens, requiredTokens: 0 }
}

/**
 * The turn's tools as the summary call sends them: the same definitions, so the prefix is the one
 * the provider cached. The instruction asks for text alone; a call the model makes anyway never
 * runs.
 */
function summaryTool(tool: Pick<ModelTool, "name" | "description" | "inputSchema">): ModelTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    parseInput: (value) => value,
    execute: async () => {
      throw new Error("[SixbAgent] A context summary runs no tools.")
    },
    errorText: () => "A context summary runs no tools.",
  }
}

/**
 * The one instruction that ends the summary request. The summary replaces the conversation in the
 * model's context, the earlier summary included, so each one is written anew from what the model
 * reads, within a length it states, instead of growing from the last.
 */
function summaryInstruction(input: {
  readonly summaryTokens: number
  /** The message the recent work kept as it is starts from, when the request reads past it. */
  readonly keptFrom?: AgentMessageRecord
}): string {
  const words = Math.max(100, Math.floor((input.summaryTokens * WORDS_PER_TOKEN) / 100) * 100)

  return [
    "<sixb_summary_request>",
    "This conversation is being compacted. The summary you write now replaces it in your context: write what you need to go on with the work from it alone.",
    ...(input.keptFrom
      ? [
          `The conversation from the user message that begins ${quoteStart(input.keptFrom)} on stays in your context as it is: summarize what comes before it, and mention what follows only under Current work.`,
        ]
      : []),
    "It replaces any earlier summary above: carry over what is still useful from it, rewritten, rather than adding to it.",
    `Write at most ${words.toLocaleString("en-US")} words of plain Markdown. No JSON, no escaped text, no message or tool call ids, and no tool calls.`,
    "",
    "Use these sections, in this order, and leave out any that would be empty:",
    "## Goal",
    "What the user wants and why, and how the request changed.",
    "## Current work",
    "What was in progress just before this summary, and the next step if one was agreed or is clearly due.",
    "## Pending work",
    "What was asked and is not done yet.",
    "## Decisions and constraints",
    "What was decided, and the user's preferences and constraints.",
    "## Errors and fixes",
    "What failed, and how it was fixed or worked around.",
    "## Files and resources",
    "Files, artifacts and attachments read, created or changed, by path, and what they hold.",
    "## Identifiers",
    "Exact ids, names, URLs, numbers and other values the work depends on.",
    "## Completed work",
    "What was done, and its results.",
    "## User messages",
    `Every message the user wrote, oldest first, each verbatim and cut after ${USER_MESSAGE_QUOTE_CHARS} characters with […]. When they do not all fit, keep the latest verbatim and sum up the older ones in a line each.`,
    "</sixb_summary_request>",
  ].join("\n")
}

/** How the instruction names a message: by its first words, else by its first file. */
function quoteStart(message: AgentMessageRecord): string {
  const text = messageText(message).replace(/\s+/g, " ").trim()
  if (text) {
    return JSON.stringify(
      text.length > KEPT_FROM_QUOTE_CHARS ? `${text.slice(0, KEPT_FROM_QUOTE_CHARS)}…` : text
    )
  }

  const file = message.parts.find((part) => part.type === "file")
  return file?.type === "file" && file.fileRef.fileName
    ? `with the file ${JSON.stringify(file.fileRef.fileName)}`
    : `sent at ${message.createdAt.toISOString()}`
}

/** A summary up to its last complete line within `maxBytes`, marked as cut short. */
function cutSummary(text: string, maxBytes: number, historyReadable: boolean): string {
  const note = historyReadable ? ` ${HISTORY_POINTER}` : ""
  return `${upToLastLine(text, maxBytes)}\n\n[The summary was cut short here.${note}]`
}

/**
 * A summary written without the model, when its answer held no text: the earlier summary and the
 * user's messages, newest last, as many as the allowance holds. The thread goes on from it rather
 * than failing every turn on the same call.
 */
function userMessagesSummary(input: {
  readonly previous: string | undefined
  readonly messages: readonly AgentMessageRecord[]
  readonly maxBytes: number
  readonly historyReadable: boolean
}): string {
  const header = "The summary could not be written. What the user asked, newest last:"
  const footer = input.historyReadable ? [HISTORY_POINTER] : []
  const quotes = input.messages
    .filter((message) => message.role === "user")
    .map((message) => messageText(message).trim())
    .filter((text) => text.length > 0)
    .map((text) => {
      const quoted =
        text.length > USER_MESSAGE_QUOTE_CHARS
          ? `${text.slice(0, USER_MESSAGE_QUOTE_CHARS)} […]`
          : text
      return `> ${quoted.replaceAll("\n", "\n> ")}`
    })

  let bytes = [header, ...footer].reduce((total, line) => total + utf8Bytes(line) + 2, 0)
  const kept: string[] = []
  for (const quote of [...quotes].reverse()) {
    bytes += utf8Bytes(quote) + 2
    if (bytes > input.maxBytes) break

    kept.unshift(quote)
  }
  const previous =
    input.previous && bytes + utf8Bytes(input.previous) + 2 <= input.maxBytes
      ? [input.previous]
      : []

  return [...previous, header, ...kept, ...footer].join("\n\n")
}

function messageText(message: AgentMessageRecord): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
}

/**
 * The text up to its last line break within `maxBytes`: what follows it was cut mid-line. Up to
 * `maxBytes` when it has no line break.
 */
function upToLastLine(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text)
  // A cut inside a multi-byte character drops it.
  const head =
    bytes.byteLength <= maxBytes
      ? text
      : new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/\uFFFD$/, "")
  const lastLine = head.lastIndexOf("\n")
  return (lastLine > 0 ? head.slice(0, lastLine) : head).trimEnd()
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

async function createCheckpoint(input: {
  readonly session: AgentRunSession
  readonly runtime: AgentTurnRuntime
  readonly run: ConversationAgentRunRecord | SubagentRunRecord
  readonly candidate: AgentContextCheckpointRecord
  readonly estimatedInputTokensAfter: number
  readonly expectedPreviousCheckpointId: string | null
}): Promise<AgentTurnHistory> {
  for (let attempt = 0; ; attempt += 1) {
    input.runtime.assertCanContinue()
    try {
      return await input.session.checkpoint({
        id: input.candidate.id,
        threadId: input.candidate.threadId,
        expectedPreviousCheckpointId: input.expectedPreviousCheckpointId,
        expectedHeadSeq: input.candidate.observedHeadSeq,
        reason: input.candidate.reason,
        summary: input.candidate.summary,
        summaryFormatVersion: input.candidate.summaryFormatVersion,
        summarizedThroughSeq: input.candidate.summarizedThroughSeq,
        observedHeadSeq: input.candidate.observedHeadSeq,
        estimatedInputTokensBefore: input.candidate.estimatedInputTokensBefore,
        estimatedInputTokensAfter: input.estimatedInputTokensAfter,
        summaryModelId: input.candidate.summaryModelId,
        createdAt: input.candidate.createdAt,
      })
    } catch (error) {
      if (error instanceof AgentExecutionLostError) throw error
      if (error instanceof AgentStorageError) {
        throw new AgentContextCompactionError(
          "checkpoint_failed",
          input.run.id,
          "The context checkpoint no longer matches the active thread state.",
          { cause: error }
        )
      }
      const delayMs = CHECKPOINT_RETRY_DELAYS_MS[attempt]
      if (delayMs === undefined) {
        throw new AgentContextCompactionError(
          "checkpoint_failed",
          input.run.id,
          "Could not persist the context checkpoint.",
          { cause: error }
        )
      }
      await wait(delayMs, input.runtime.signal)
    }
  }
}

function requiredHeadSeq(
  messages: readonly AgentMessageRecord[],
  run: ConversationAgentRunRecord | SubagentRunRecord
): number {
  const head = messages.at(-1)?.seq
  if (head === undefined) {
    throw new AgentContextCompactionError(
      "checkpoint_failed",
      run.id,
      "Cannot compact a thread without a retained trigger message."
    )
  }
  return head
}

/**
 * The run's environment failed while it built the summary request, as acquiring its workspace or
 * reading its files: that failure is the run's, not compaction's.
 */
class ConversationRequestFailure extends Error {
  readonly name = "ConversationRequestFailure"

  constructor(override readonly cause: unknown) {
    super("[SixbAgent] The summary request could not be built.", { cause })
  }
}

function normalizeCompactionError(error: unknown, runId: string): AgentContextCompactionError {
  if (error instanceof ConversationRequestFailure) throw error.cause
  if (error instanceof AgentContextCompactionError) return error
  if (error instanceof AgentExecutionLostError || isModelCallAccountingFailure(error)) throw error
  return new AgentContextCompactionError(
    "checkpoint_failed",
    runId,
    "Context compaction failed before the checkpoint became active.",
    { cause: error }
  )
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
