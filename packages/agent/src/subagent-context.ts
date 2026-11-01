import {
  type AgentThreadModelContextMessage,
  agentRunApprovalMode,
  conversationThreadId,
  shouldCompactAgentContext,
  toModelMessages,
} from "@sixb/core/internal/agents"
import { createSixbError, withFailureMessage } from "@sixb/core/internal/errors"
import { type ModelCachingIntent, type ModelMessage, ModelProviderError } from "@sixb/core/models"
import type { AgentMessageRecord, AgentThreadRecord, SubagentRunRecord } from "@sixb/core/storage"
import {
  attachmentKey,
  type PreparedAgentAttachmentContext,
  toolResultAttachmentKey,
} from "./attachments"
import {
  type AgentThreadCompactionInput,
  compactAgentThreadInRun,
  estimateAgentConversation,
  inRunCompactedTokens,
  shouldCompactIdleContext,
} from "./context-compaction"
import { childCacheLifetime, conversationPromptCaching } from "./prompt-cache"
import type { SubagentHistory } from "./subagent-continuation"
import { agentThreadModelContext, type LoadedAgentThreadModelContext } from "./thread-context"
import { toolFilesStepKey } from "./tools/result-media"

// A child keeps its calls under its model's limit as a conversation's turn does (see
// createAgentContextGuard): its thread is its history, its task apart. Every request opens with
// the task as it was sent, then the thread: from its latest checkpoint's summary once it has one.
// A run that continues the thread compacts what came before the message it started from, on the
// child's own thread, before its environment is built, as a conversation's preflight does: past
// the limit, or idle and large. Its own steps are cleared, never summarized. A first run has
// nothing before its task, so it only clears.

/** A child's thread as its requests send it: its task, and the history after it. */
export interface SubagentThreadContext {
  /** The thread's first message, which every request opens with. */
  readonly task?: AgentMessageRecord
  /** The thread without its task: from the latest checkpoint's summary once it has one. */
  readonly threadContext: LoadedAgentThreadModelContext
}

/** Split a child's history into its task and the rest of its thread. */
export function subagentThreadContext(history: SubagentHistory): SubagentThreadContext {
  // Until a checkpoint summarized it, the task is the thread's first message.
  const task = history.task ?? (history.checkpoint ? undefined : history.messages[0])
  const messages = history.checkpoint ? history.messages : history.messages.slice(1)

  return {
    ...(task ? { task } : {}),
    threadContext: agentThreadModelContext({ ...history, messages }, { historyReadable: false }),
  }
}

/**
 * The child's thread as its model reads it: the task, closed by the time the thread was created
 * so each run of the child replays the same bytes, then the rest. Files a tool showed it are
 * projected again as a turn projects its own.
 */
export function subagentModelMessages(input: {
  readonly thread: SubagentThreadContext
  readonly attachmentContext?: PreparedAgentAttachmentContext
  /** When the thread was created, as the task closes with it. */
  readonly createdAt: string
}): ModelMessage[] {
  const { task, threadContext } = input.thread
  const projections = input.attachmentContext
  const byMessage = <T>(
    message: AgentThreadModelContextMessage,
    read: (messageId: string) => T | undefined
  ): T | undefined => (message.id ? read(message.id) : undefined)

  return toModelMessages([...(task ? [task] : []), ...threadContext.modelMessages], {
    userMessageSuffix: (message) => (task && message.id === task.id ? input.createdAt : undefined),
    fileText: ({ message, partIndex }) =>
      byMessage(message, (id) =>
        projections?.promptTextByPartKey.get(attachmentKey(id, partIndex))
      ),
    fileData: ({ message, partIndex }) =>
      byMessage(message, (id) =>
        projections?.modelFileDataByPartKey.get(attachmentKey(id, partIndex))
      ),
    toolResultFileText: ({ message, partIndex, contentIndex }) =>
      byMessage(message, (id) =>
        projections?.promptTextByPartKey.get(toolResultAttachmentKey(id, partIndex, contentIndex))
      ),
    afterToolResults: ({ message, partIndex }) =>
      byMessage(message, (id) =>
        projections?.toolFilesByStep?.get(toolFilesStepKey(id, partIndex))
      ),
  })
}

/** How a child's calls are cached, its summary's included (see childCacheLifetime). */
export function subagentPromptCaching(input: {
  readonly projectId: string
  readonly thread: AgentThreadRecord
  readonly run: SubagentRunRecord
  readonly history: SubagentHistory
}): ModelCachingIntent {
  const { run, history } = input
  return conversationPromptCaching({
    projectId: input.projectId,
    threadId: conversationThreadId(input.thread),
    lifetime: childCacheLifetime({
      runsEveryCall: agentRunApprovalMode(run) === "auto",
      // A run that continues the thread finds an earlier run's messages there, or their summary.
      continues:
        history.checkpoint !== null || history.messages.some((message) => message.runId !== run.id),
    }),
  })
}

/**
 * Weigh a child's thread before its first call, and compact it when it crosses the model's limit,
 * or when it comes back idle and large (see shouldCompactIdleContext): what the run then starts
 * from, and the bytes per token the thread was measured at.
 */
export async function preflightSubagentContext(
  input: AgentThreadCompactionInput & { readonly threadContext: LoadedAgentThreadModelContext }
): Promise<{
  readonly threadContext: LoadedAgentThreadModelContext
  readonly bytesPerToken: number
}> {
  const { plan, budget, threadContext } = input
  const estimateShape = input.estimateShape(threadContext, undefined)
  const estimate = estimateAgentConversation({ plan, budget, threadContext, ...estimateShape })
  const overLimit = shouldCompactAgentContext({
    estimatedInputTokens: estimate.tokens,
    inputBudgetTokens: budget.inputBudgetTokens,
  })

  // The same rule as a conversation's turn: compacting brings an idle thread under its size.
  const idle =
    !overLimit &&
    shouldCompactIdleContext({
      history: threadContext.history,
      caching: input.caching,
      estimatedInputTokens: estimate.tokens,
      compactedTokens: inRunCompactedTokens({
        plan,
        budget,
        threadContext,
        estimateShape,
        bytesPerToken: estimate.bytesPerToken,
      }),
    })
  if (!overLimit && !idle) return { threadContext, bytesPerToken: estimate.bytesPerToken }

  const compacted = await compactAgentThreadInRun({
    ...input,
    memory: undefined,
    reason: "threshold",
    // Below the limit, the thread compacts because it came back idle: its cache has gone cold.
    coldCache: !overLimit,
  })
  return {
    threadContext: compacted?.threadContext ?? threadContext,
    bytesPerToken: estimate.bytesPerToken,
  }
}

/**
 * The failure of a child whose call its guard reduced and the provider still refused as too long
 * for the window: what its parent can do about it. Undefined for any other error.
 */
export function subagentContextFailure(error: unknown, run: SubagentRunRecord): Error | undefined {
  if (!(error instanceof ModelProviderError) || error.reason !== "context-window-exceeded") {
    return undefined
  }

  const remedy = "Spawn it again with a narrower task, or a model with a larger context window."
  return withFailureMessage(
    createSixbError(
      "agent.execution_failed",
      `[SixbAgent] Subagent run '${run.id}' still exceeds its model's context window after its context was reduced. ${remedy}`,
      { cause: error, details: { parentRunId: run.parentRunId, runId: run.id } }
    ),
    `The subagent's context exceeds its model's context window, even reduced. ${remedy}`
  )
}
