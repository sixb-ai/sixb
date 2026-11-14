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
import { conversationAuthors, type ConversationReaders } from "./message-authors"
import {
  type AgentToolOutputFileOf,
  agentTraceFromModelSteps,
  agentTraceFromPartialModelLoop,
} from "./model-adapters"

/** A steer the turn read at one of its step boundaries: which step, and what it read. */
export interface TurnInboxDelivery {
  /** The step the messages came after: its own count of the steps the turn completed. */
  readonly afterSteps: number
  readonly items: readonly AgentInboxItemRecord[]
}

/** What a steer's message is projected from: the thread as the turn started, and who reads it. */
interface TurnInboxContext {
  readonly retainedMessages: readonly AgentMessageRecord[]
  readonly conversation?: ConversationReaders
  readonly project: SentSettings
}

/**
 * A turn's mid-run steers, drained from its session's inbox at step boundaries.
 *
 * Every item a turn reads is claimed by its run and its step, so a step that reads twice reads
 * once, and a turn that never writes one releases it (see AgentRunSession.finish). The messages
 * here are what the model read: its history plus the steer, projected the way the next turn's
 * replay of `agent_messages` projects it, so both send the same bytes.
 */
export class TurnInbox {
  readonly #deliveries: TurnInboxDelivery[] = []
  #read: AgentInboxItemRecord[] = []
  readonly #context: TurnInboxContext

  constructor(private readonly session: AgentRunSession, context: TurnInboxContext) {
    this.#context = context
  }

  /** What the turn read, in order. */
  get deliveries(): readonly TurnInboxDelivery[] {
    return this.#deliveries
  }

  /**
   * The messages the model reads after `afterSteps` steps; none when nothing waits. `afterAnswer`
   * marks a read that came as the model answered, which the next request follows with one more
   * step.
   */
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
    this.#read = [...this.#read, ...items]
    return steerModelMessages(items, this.#context, this.#read)
  }
}

/**
 * A steer's parts as one user message, projected as a later turn replays it. A steer carries text
 * and context only: storage refuses a file, whose text a later turn derives from the attachments it
 * prepares, so the bytes could not be the same.
 */
function steerModelMessages(
  items: readonly AgentInboxItemRecord[],
  context: TurnInboxContext,
  read: readonly AgentInboxItemRecord[]
): readonly ModelMessage[] {
  // Who wrote them, as the thread reads once they are saved: the turn appends each steer to the
  // conversation a later turn replays, so the same authors close the same messages.
  const authors = context.conversation
    ? conversationAuthors({
        conversation: context.conversation,
        messages: [...context.retainedMessages, ...read.map(savedRecord)],
      }).byMessageId
    : undefined

  const closing = new Map<string, string>()
  for (const item of items) {
    const sent = renderCurrentTime(item.createdAt, {
      timeZone: item.timeZone ?? context.project.timeZone,
      locale: item.locale ?? context.project.locale,
    })
    closing.set(item.messageId, [sent, authors?.get(item.messageId)].filter(Boolean).join("\n"))
  }

  return toModelMessages(
    items.map((item) => ({ id: item.messageId, role: "user" as const, parts: item.parts })),
    { userMessageSuffix: (message) => (message.id ? closing.get(message.id) : undefined) }
  )
}

/** A steer as the conversation holds it once the turn appends it: what its authors read from. */
function savedRecord(item: AgentInboxItemRecord): AgentMessageRecord {
  return {
    id: item.messageId,
    projectId: item.projectId,
    threadId: item.threadId,
    runId: null,
    role: "user",
    authorPrincipal: item.authorPrincipal,
    seq: 0,
    parts: item.parts,
    contentVersion: AGENT_MESSAGE_CONTENT_VERSION,
    createdAt: item.createdAt,
  }
}

/**
 * Slice the steps a turn completed, or the part of one it did not, around the steers it read, as
 * `agent_messages` rows: one assistant message up to each delivery, the steer as its own user
 * message, then the rest. A steer no step followed — the turn stopped before answering it — is
 * left out, so finishing without its message releases it back to the thread's inbox.
 */
export function turnWorkMessages(input: {
  readonly steps: readonly ModelStep[]
  /** What an aborted step streamed: the one step `steps` does not hold whole. */
  readonly partialContent?: readonly ModelAssistantPart[]
  readonly aborted?: boolean
  readonly run: ConversationAgentRunRecord
  readonly deliveries: readonly TurnInboxDelivery[]
  /** The first step whose request the context guard reduced: it and those after it are marked. */
  readonly reducedFromStep?: number
  readonly stepRequests: readonly (AgentStepRequestSize | undefined)[]
  readonly outputFileOf?: AgentToolOutputFileOf
  readonly authorPrincipal?: Principal
}): readonly AppendAgentMessageInput[] {
  const { steps, run, deliveries, reducedFromStep, stepRequests, outputFileOf } = input
  const details = { threadId: run.threadId, runId: run.id }
  const messages: AppendAgentMessageInput[] = []

  const pushSteps = (parts: readonly AgentMessagePart[], from: number, to: number) => {
    const marked = recordStepRequests(
      markReducedSteps(parts, reducedFromStep === undefined ? undefined : reducedFromStep - from),
      stepRequests.slice(from, to)
    )
    if (!marked.some((part) => part.type !== "step-start")) return

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

  // A delivery no step followed reads unread: the turn stopped before the model answered it.
  const answered = (delivery: TurnInboxDelivery) => {
    if (steps.length > delivery.afterSteps) return true
    return input.aborted === true && (input.partialContent?.length ?? 0) > 0
  }

  let from = 0
  for (const delivery of deliveries) {
    pushSteps(
      agentTraceFromModelSteps(steps.slice(from, delivery.afterSteps), details, outputFileOf),
      from,
      delivery.afterSteps
    )
    from = delivery.afterSteps
    if (!answered(delivery)) break

    for (const item of delivery.items) {
      messages.push(savedSteer(item))
    }
  }

  const rest = steps.slice(from)
  pushSteps(
    input.aborted === true
      ? agentTraceFromPartialModelLoop(rest, input.partialContent ?? [], details, outputFileOf)
      : agentTraceFromModelSteps(rest, details, outputFileOf),
    from,
    stepRequests.length
  )
  return messages
}

/** The rows a turn finishes with, for the model loop it just ran. */
export function turnResultMessages(
  result: PausableModelLoopResult,
  input: Omit<Parameters<typeof turnWorkMessages>[0], "steps" | "partialContent" | "aborted">
): readonly AppendAgentMessageInput[] {
  return result.status === "aborted"
    ? turnWorkMessages({
        ...input,
        steps: result.steps,
        partialContent: result.partialContent,
        aborted: true,
      })
    : turnWorkMessages({ ...input, steps: result.steps })
}

/**
 * A steer as the thread keeps it: a user message of no run, authored by whoever sent it, with the
 * time zone and locale its `<sixb_current_time>` was rendered in.
 */
function savedSteer(item: AgentInboxItemRecord): AppendAgentMessageInput {
  const metadata =
    item.timeZone === undefined && item.locale === undefined
      ? undefined
      : {
          ...(item.timeZone === undefined ? {} : { timeZone: item.timeZone }),
          ...(item.locale === undefined ? {} : { locale: item.locale }),
        }
  return {
    id: item.messageId,
    projectId: item.projectId,
    threadId: item.threadId,
    runId: null,
    role: "user",
    parts: item.parts,
    authorPrincipal: item.authorPrincipal,
    createdAt: item.createdAt,
    ...(metadata === undefined ? {} : { metadata }),
  }
}

/**
 * Mark each step from `fromStep` on as answering a request the turn reduced, for the next turn's
 * estimate not to go by what those calls read.
 */
export function markReducedSteps(
  parts: readonly AgentMessagePart[],
  fromStep: number | undefined
): readonly AgentMessagePart[] {
  if (fromStep === undefined) return parts

  let step = -1
  return parts.map((part) => {
    if (part.type !== "step-start") return part

    step += 1
    return step >= fromStep ? { type: "step-start", reducedRequest: true } : part
  })
}

/**
 * Record on each step-start what its request carried, by step: the next turn's context meter
 * reads the system prompt and tools the latest one sent.
 */
export function recordStepRequests(
  parts: readonly AgentMessagePart[],
  requests: readonly (AgentStepRequestSize | undefined)[]
): readonly AgentMessagePart[] {
  let step = -1
  return parts.map((part) => {
    if (part.type !== "step-start") return part

    step += 1
    const request = requests[step]
    return request ? { ...part, request } : part
  })
}
