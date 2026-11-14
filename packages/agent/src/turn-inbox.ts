import type { AgentMessagePart, AgentStepRequestSize } from "@sixb/core"
import {
  AGENT_MESSAGE_CONTENT_VERSION,
  type AgentRunSession,
  createAgentMessageId,
  type PausableModelLoopResult,
  toModelMessages,
} from "@sixb/core/internal/agents"
import type { ModelAssistantPart, ModelMessage, ModelStep } from "@sixb/core/models"
import type {
  AgentInboxItemRecord,
  AgentMessageRecord,
  AppendAgentMessageInput,
  ConversationAgentRunRecord,
  Principal,
} from "@sixb/core/storage"
import { renderCurrentTime, type SentSettings } from "./agent-prompt"
import { type ConversationReaders, conversationAuthors } from "./message-authors"
import {
  type AgentToolOutputFileOf,
  agentTraceFromModelSteps,
  agentTraceFromPartialModelLoop,
} from "./model-adapters"
import { markReducedSteps, recordStepRequests } from "./run-agent-turn"

/** Steers a conversation turn read at one step boundary. */
export interface TurnInboxDelivery {
  readonly afterSteps: number
  readonly items: readonly AgentInboxItemRecord[]
}

/**
 * Drains mid-run `steer` items from the turn's durable session inbox at step boundaries and
 * projects them into model messages whose bytes match Turn N+1 replay from `agent_messages`.
 */
export class TurnInbox {
  readonly #deliveries: TurnInboxDelivery[] = []

  constructor(
    private readonly session: AgentRunSession,
    private readonly options: {
      readonly retainedMessages: readonly AgentMessageRecord[]
      readonly conversation?: ConversationReaders
      readonly project: SentSettings
    }
  ) {}

  get deliveries(): readonly TurnInboxDelivery[] {
    return this.#deliveries
  }

  async take(
    afterSteps: number,
    options: { readonly afterAnswer?: boolean } = {}
  ): Promise<readonly ModelMessage[]> {
    const items = await this.session.inbox.takeSteers({
      stepIndex: afterSteps,
      ...(options.afterAnswer ? { afterAnswer: true } : {}),
    })
    if (items.length === 0) return []

    this.#deliveries.push({ afterSteps, items })
    return steerModelMessages(items, this.options)
  }
}

function steerModelMessages(
  items: readonly AgentInboxItemRecord[],
  options: {
    readonly retainedMessages: readonly AgentMessageRecord[]
    readonly conversation?: ConversationReaders
    readonly project: SentSettings
  }
): readonly ModelMessage[] {
  const syntheticRecords = items.map<AgentMessageRecord>((item, index) => ({
    id: item.messageId,
    projectId: item.projectId,
    threadId: item.threadId,
    runId: null,
    role: "user",
    authorPrincipal: item.authorPrincipal,
    seq: (options.retainedMessages.at(-1)?.seq ?? 0) + index + 1,
    parts: item.parts,
    contentVersion: AGENT_MESSAGE_CONTENT_VERSION,
    createdAt: item.createdAt,
  }))
  const authors = options.conversation
    ? conversationAuthors({
        conversation: options.conversation,
        messages: [...options.retainedMessages, ...syntheticRecords],
      })
    : undefined
  const times = new Map(
    items.map((item) => [
      item.messageId,
      renderCurrentTime(item.createdAt, {
        timeZone: item.timeZone ?? options.project.timeZone,
        locale: item.locale ?? options.project.locale,
      }),
    ])
  )

  return toModelMessages(
    items.map((item) => ({ id: item.messageId, role: "user" as const, parts: item.parts })),
    {
      userMessageSuffix: (message) => {
        if (!message.id) return undefined
        const closing = [times.get(message.id), authors?.byMessageId.get(message.id)]
        return closing.filter(Boolean).join("\n") || undefined
      },
    }
  )
}

/**
 * Slice a turn's completed or partial steps around each mid-run steer delivery so `agent_messages`
 * stores alternating `[assistant, user, assistant]` rows matching the exact prefix the model read.
 * A trailing delivery with no assistant work after it (e.g. aborted before the step produced tokens)
 * is omitted so `consumeClaimed` releases it back to the pending inbox.
 */
export function turnWorkMessages(input: {
  readonly steps: readonly ModelStep[]
  readonly partialContent?: readonly ModelAssistantPart[]
  readonly aborted?: boolean
  readonly run: ConversationAgentRunRecord
  readonly deliveries: readonly TurnInboxDelivery[]
  readonly reducedFromStep?: number
  readonly stepRequests: readonly (AgentStepRequestSize | undefined)[]
  readonly outputFileOf?: AgentToolOutputFileOf
  readonly authorPrincipal?: Principal
}): readonly AppendAgentMessageInput[] {
  const { steps, run, deliveries, reducedFromStep, stepRequests, outputFileOf } = input
  const details = { threadId: run.threadId, runId: run.id }
  const messages: AppendAgentMessageInput[] = []

  const pushAssistantSlice = (parts: readonly AgentMessagePart[], from: number, to: number) => {
    const marked = recordStepRequests(
      markReducedSteps(parts, reducedFromStep === undefined ? undefined : reducedFromStep - from),
      stepRequests.slice(from, to)
    )
    if (marked.some((part) => part.type !== "step-start")) {
      messages.push({
        id: createAgentMessageId(),
        projectId: run.projectId,
        threadId: run.threadId,
        runId: run.id,
        role: "assistant",
        parts: marked,
        ...(input.authorPrincipal === undefined ? {} : { authorPrincipal: input.authorPrincipal }),
      })
    }
  }

  const hasTailAfter = (afterSteps: number): boolean => {
    if (steps.length > afterSteps) return true
    if (!input.aborted) return false
    return (input.partialContent?.length ?? 0) > 0
  }

  let from = 0
  for (const delivery of deliveries) {
    pushAssistantSlice(
      agentTraceFromModelSteps(steps.slice(from, delivery.afterSteps), details, outputFileOf),
      from,
      delivery.afterSteps
    )
    from = delivery.afterSteps
    if (!hasTailAfter(delivery.afterSteps)) break

    for (const item of delivery.items) {
      const metadata =
        item.timeZone || item.locale
          ? {
              ...(item.timeZone ? { timeZone: item.timeZone } : {}),
              ...(item.locale ? { locale: item.locale } : {}),
            }
          : undefined
      messages.push({
        id: item.messageId,
        projectId: item.projectId,
        threadId: item.threadId,
        runId: null,
        role: "user",
        parts: item.parts,
        authorPrincipal: item.authorPrincipal,
        createdAt: item.createdAt,
        ...(metadata ? { metadata } : {}),
      })
    }
  }

  const rest = steps.slice(from)
  const tailParts = input.aborted
    ? agentTraceFromPartialModelLoop(rest, input.partialContent ?? [], details, outputFileOf)
    : agentTraceFromModelSteps(rest, details, outputFileOf)
  pushAssistantSlice(tailParts, from, steps.length + (input.aborted ? 1 : 0))
  return messages
}

export function loopResultMessages(
  result: PausableModelLoopResult,
  options: Omit<Parameters<typeof turnWorkMessages>[0], "steps" | "partialContent" | "aborted">
): readonly AppendAgentMessageInput[] {
  return result.status === "aborted"
    ? turnWorkMessages({
        ...options,
        steps: result.steps,
        partialContent: result.partialContent,
        aborted: true,
      })
    : turnWorkMessages({
        ...options,
        steps: result.steps,
      })
}
