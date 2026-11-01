import type { FileRef } from "../blob-storage"
import type { JsonValue } from "../json"
import type { ProviderData } from "../models"
import type {
  AgentApprovalCall,
  AgentApprovalOutcome,
  AgentApprovalStatus,
} from "../storage/agents/types"
import type { AgentContextPart } from "./context/entries"

/**
 * The agent's own, SDK-independent message. We store messages and threads — not an SDK transport —
 * so a message is just a `role` plus structured `parts` (and optional `metadata`). There is no
 * self-describing wrapper: the storage row owns the message's identity, and `contentVersion` (a
 * column) versions the parts shape so it can be migrated.
 *
 * The part union is intentionally focused on what agent runs actually produce (text, reasoning, step
 * boundaries, tool calls). The model loop validates and normalizes output before its steps are
 * projected into this union; storage validates the durable write contract independently.
 */
export const AGENT_MESSAGE_CONTENT_VERSION = 2 as const

export type AgentMessageRole = "system" | "user" | "assistant"

/** A plain text part (assistant output, user input, or system text). */
export interface AgentTextPart {
  readonly type: "text"
  readonly text: string
  /** Provider passthrough (kept because some providers require it on the next turn). */
  readonly providerMetadata?: ProviderData
}

/**
 * A reasoning ("thinking") part. `providerMetadata` is load-bearing here: some providers require
 * the reasoning signature back on the following turn, so dropping it would break multi-step loops.
 */
export interface AgentReasoningPart {
  readonly type: "reasoning"
  readonly text: string
  readonly providerMetadata?: ProviderData
}

/** A step boundary between assistant loop iterations. */
export interface AgentStepStartPart {
  readonly type: "step-start"
  /**
   * The step answered a request whose tool results the turn cleared or cut to fit its context:
   * the provider counted less for it than replaying the stored steps sends.
   */
  readonly reducedRequest?: true
  /** What the step's request carried, part by part, as the turn sent it. */
  readonly request?: AgentStepRequestSize
}

/**
 * The parts a request is made of, as a context meter shows them: Sixb's own prompt, the project's
 * `SIXB.md`, memory, skills and ontology (their index in the prompt and the files the agent read),
 * the tool definitions, the summary of a condensed conversation, its messages, the other tool
 * results, and attachments and images.
 */
export type AgentContextPartName =
  | "system"
  | "instructions"
  | "memory"
  | "skills"
  | "ontology"
  | "tools"
  | "summary"
  | "messages"
  | "toolResults"
  | "files"

/** The parts of the system prompt. */
export type AgentSystemPromptPartName = Extract<
  AgentContextPartName,
  "system" | "instructions" | "memory" | "skills" | "ontology"
>

/** The parts of the history: a file the agent read counts with what it is. */
export type AgentHistoryPartName = Extract<
  AgentContextPartName,
  "summary" | "messages" | "toolResults" | "files" | "memory" | "skills" | "ontology"
>

/** UTF-8 bytes by part; a part the request did not carry is left out. */
export type AgentContextPartBytes<TPart extends AgentContextPartName> = {
  readonly [Part in TPart]?: number
}

/** A step's request as sent: UTF-8 bytes by part, and the images apart, which count by the image. */
export interface AgentStepRequestSize {
  readonly system: AgentContextPartBytes<AgentSystemPromptPartName>
  readonly tools: { readonly count: number; readonly bytes: number }
  readonly history: AgentContextPartBytes<AgentHistoryPartName>
  readonly images?: number
  /** Where the run's context files were, which its reads were attributed by. */
  readonly contextDirectory?: string
}

/** A blob-backed file attached to a user message or produced by an agent/tool. */
export interface AgentFilePart {
  readonly type: "file"
  readonly fileRef: FileRef
  /** Provider passthrough for future model-specific file handling. */
  readonly providerMetadata?: ProviderData
}

interface AgentToolCallBase {
  readonly type: "tool-call"
  readonly toolCallId: string
  readonly toolName: string
  /** `true` when the model identifies the call as a dynamic tool. */
  readonly dynamic?: boolean
  /** `true` when the provider executed the tool inline (steers model projection). */
  readonly providerExecuted?: boolean
  readonly input: JsonValue
  readonly providerMetadata?: ProviderData
}

/**
 * The user asked the Agent to continue an answer the turn limit cut short. Sixb writes the
 * instruction the model reads; chats show no message for it.
 */
export interface AgentContinuationPart {
  readonly type: "continuation"
}

/**
 * How a call the Agent made in an earlier turn ended, once its requester decided on it or it was
 * set aside. Sixb writes it at the start of the next user message; chats show no text for it.
 */
export interface AgentApprovalOutcomePart {
  readonly type: "approval-outcome"
  readonly approvalId: string
  readonly status: Exclude<AgentApprovalStatus, "pending">
  readonly call: AgentApprovalCallSummary
  /** What the approved call gave, when it ran. */
  readonly outcome?: AgentApprovalOutcome
  /** The turn's sub-agent that made the call, when the turn did not make it itself. */
  readonly caller?: AgentApprovalCaller
}

/** A turn's sub-agent that made a call: its run, and the key it was spawned with. */
export interface AgentApprovalCaller {
  readonly runId: string
  readonly key: string
  /** The message resumes the turn and the sub-agent paused on its calls: it goes on. */
  readonly continues?: true
}

/** The call an approval held, as the model asked for it, without its params. */
export type AgentApprovalCallSummary =
  | Pick<Extract<AgentApprovalCall, { readonly kind: "action" }>, "kind" | "actionId" | "subject">
  | Pick<Extract<AgentApprovalCall, { readonly kind: "workflow" }>, "kind" | "workflowId">

/**
 * A message a sub-agent read before its next step: today, its parent steering it, or answering the
 * question it paused on. Sixb writes it in the sub-agent's thread, where the child read it; the
 * model reads it as data from the sender, never from the user.
 */
export interface AgentMailPart {
  readonly type: "mail"
  /** The mail's id, the same in the sender's and the reader's records. */
  readonly id: string
  readonly from: "parent"
  /** `answer`: the reply to the question it asked, `inReplyTo`. */
  readonly kind: "message" | "answer"
  /** The question an answer replies to. */
  readonly inReplyTo?: string
  readonly text: string
  /**
   * It came as the reader answered: the sender has not received that answer, so the reader writes
   * its whole result again.
   */
  readonly afterAnswer?: true
}

/** Ordered, hidden provider state required to replay a model response losslessly. */
export interface AgentProviderStatePart {
  readonly type: "provider-state"
  readonly providerId: string
  readonly data: JsonValue
}

/**
 * A completed tool call. Only terminal states are modelled — transient states
 * (`input-streaming`, `input-available`, `approval-*`) are never persisted because messages are
 * written only once a run finishes.
 */
export type AgentToolCallPart = AgentToolCallBase &
  (
    | {
        readonly state: "output-available"
        readonly output: JsonValue
        /**
         * What the model read of `output`, when its tool projected it into something else (a
         * summary, a file's excerpt): later turns replay these bytes instead of projecting `output`
         * again. Internal to the runtime; the HTTP API leaves it out.
         */
        readonly modelOutput?:
          | { readonly type: "text"; readonly value: string }
          | { readonly type: "json"; readonly value: JsonValue }
        /**
         * The whole output, when it was too large for the model's context: a stored file, and
         * where the run's sandbox holds it, relative to its context directory. `output` then keeps
         * a bounded copy, and the model read a preview with that path.
         */
        readonly outputFile?: { readonly fileRef: FileRef; readonly path: string }
      }
    | { readonly state: "output-error"; readonly errorText: string }
  )

export type AgentMessagePart =
  | AgentTextPart
  | AgentReasoningPart
  | AgentStepStartPart
  | AgentFilePart
  | AgentContextPart
  | AgentContinuationPart
  | AgentApprovalOutcomePart
  | AgentMailPart
  | AgentToolCallPart
  | AgentProviderStatePart

export type AgentMessagePartType = AgentMessagePart["type"]
export type AgentToolCallState = AgentToolCallPart["state"]

/** The logical agent message the adapters speak and the store persists (as columns). */
export interface AgentMessage {
  readonly role: AgentMessageRole
  readonly parts: readonly AgentMessagePart[]
  /** Optional JSON metadata associated with the message. */
  readonly metadata?: JsonValue
}
