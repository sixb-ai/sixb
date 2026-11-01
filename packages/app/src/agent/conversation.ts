import { type FileSource, messageFileSource } from "../artifacts/file-source"
import { isApprovalOutcomeMessage } from "./approvals"
import type { LiveRunState } from "./live-run"
import { knownName, type MessageAuthor, principalKey } from "./message-authors"
import {
  type NormalizedFile,
  type NormalizedPart,
  type NormalizedTool,
  toolResultFiles,
} from "./parts"
import type { ActiveTurnPresentation } from "./run-presentation"
import type { AgentToolViewProps } from "./tool-views/define"
import { toolViewProps } from "./tool-views/registry"
import type {
  AgentContextEntryInput,
  AgentContextInput,
  AgentFileRef,
  AgentMessage,
  AgentRun,
  AgentThread,
} from "./types"

// The conversation as one list: saved messages, the message the reader just sent, and the reply
// streaming in, each with a key that survives the handoff to its saved copy. `useAgentConversation`
// and the observer view build it with `conversationMessages`, and `Transcript` draws it.

/** Reads a saved file of a message: its URLs, or `load()` for its bytes with the reader's rights. */
export type AgentFileSource = FileSource

/** A file in a message. Its source exists once the message is saved. */
export interface AgentConversationFile {
  readonly fileRef: AgentFileRef
  readonly source?: AgentFileSource
}

/**
 * One tool call of a reply, as it streams or as it was saved. Its `state` says which of the call's
 * input, output and error it holds, as for a tool's view; no tool types them here.
 */
export type AgentConversationToolPart = {
  readonly type: "tool"
  readonly toolName: string
  readonly toolCallId?: string
  /** Files in a saved rich result, such as the image `view_file` prepared for the model. */
  readonly files?: readonly AgentConversationFile[]
} & AgentToolViewProps

/**
 * What a message says, in order. Two text parts in a row are two steps of the reply; the built-in
 * chat shows them as separate paragraphs.
 */
export type AgentConversationPart =
  | { readonly type: "text"; readonly text: string; readonly streaming: boolean }
  | { readonly type: "reasoning"; readonly text: string; readonly streaming: boolean }
  | ({ readonly type: "file" } & AgentConversationFile)
  | AgentConversationToolPart

type AgentPrincipalType = NonNullable<AgentMessage["authorPrincipal"]>["type"]

/** Who wrote a user message. */
export interface AgentConversationAuthor {
  readonly type: AgentPrincipalType
  readonly id: string
  /** Their account's name, when it has one. */
  readonly displayName?: string
  /** The person reading the conversation wrote it. */
  readonly isReader: boolean
}

/** Why a reply stopped short of finishing, such as `output_limit_reached`. */
export type AgentConversationDiagnostic = AgentMessage["annotations"][number]

/** A message of the conversation: saved, just sent, or streaming in. */
export interface AgentConversationMessage {
  /** Stable from the message the reader sends to its saved copy, and from a reply's stream to its. */
  readonly key: string
  /** The saved message's id, once the conversation holds it. */
  readonly id: string | null
  readonly role: "user" | "assistant"
  /**
   * `pending`: sent, not saved yet. `streaming`: a reply that still comes from its run, until its
   * saved copy replaces it. `complete`: everything else.
   */
  readonly status: "pending" | "streaming" | "complete"
  /** The run that wrote a reply. */
  readonly runId: string | null
  /** Who wrote a user message, when known. */
  readonly author?: AgentConversationAuthor
  readonly parts: readonly AgentConversationPart[]
  /** What a user message pointed the agent at: objects and app state, shown as chips. */
  readonly context: readonly AgentContextEntryInput[]
  /** Why a saved reply stopped short of finishing; `conversation.continue()` can finish it. */
  readonly diagnostics: readonly AgentConversationDiagnostic[]
  /** Earlier turns were condensed before this reply: the summary the agent read instead. */
  readonly compaction?: NonNullable<AgentMessage["compaction"]>
  /**
   * A reply whose run ended before finishing it: it failed, or someone stopped it. The turn tells
   * only of a turn that ended without any answer.
   */
  readonly unfinished?: "failed" | "cancelled"
}

/** What the reader sent, shown until the conversation holds the saved message. */
export interface PendingUserMessage {
  readonly key: string
  readonly threadId: string
  readonly text: string
  readonly attachments: readonly AgentFileRef[]
  readonly context: readonly AgentContextEntryInput[]
  /** The saved message's id, once the API accepted it. */
  readonly messageId: string | null
}

export interface ConversationMessagesInput {
  /** The saved messages, oldest first. */
  readonly messages: readonly AgentMessage[]
  /** The message page's authors, with their names. */
  readonly authors?: readonly MessageAuthor[]
  /** The conversation, whose people's names win over the authors'. */
  readonly thread?: AgentThread | null
  /** Who reads it: their messages say so, and a pending message is theirs. */
  readonly reader?: {
    readonly type: AgentPrincipalType
    readonly id: string
    readonly displayName?: string
  }
  /** Read through the observer's routes: the conversation is someone else's. */
  readonly observed?: boolean
  readonly pending?: PendingUserMessage | null
  /** The key each message the reader sent had while pending, by its saved id. */
  readonly sentKeys?: ReadonlyMap<string, string>
  /** The conversation's runs: a saved reply whose run failed or was stopped says it did not finish. */
  readonly runs?: readonly AgentRun[]
  /** The run followed live; an observer follows none. */
  readonly live?: LiveRunState | null
  readonly presentation: ActiveTurnPresentation
}

/**
 * The conversation as one list. A pending message gives way to its saved copy, and the live reply
 * to its own, keeping their keys; until the copy is there, the pending or live one stands for it.
 * An interrupted turn that saved nothing drops what it streamed, and the message Continue writes for
 * the model is not shown.
 */
export function conversationMessages(input: ConversationMessagesInput): AgentConversationMessage[] {
  const result: AgentConversationMessage[] = []
  const keys = new Set<string>()
  const savedIds = new Set<string>()
  const answeredRuns = new Set<string>()
  const ended = new Map<string, "failed" | "cancelled">()
  for (const run of input.runs ?? []) {
    if (run.status === "failed" || run.status === "cancelled") ended.set(run.id, run.status)
  }

  for (const message of input.messages) {
    if (message.role === "system") continue

    savedIds.add(message.id)
    if (message.role === "assistant" && message.runId !== null) answeredRuns.add(message.runId)

    // Continue writes the model a message the reader never wrote: nothing to draw. Neither is the
    // one a decision resumes a turn with: its calls' cards say how they ended, and the resumed
    // answer stays right under the one it continues.
    if (isContinuation(message) || isApprovalOutcomeMessage(message)) continue

    // One reply per run: a second one, which nothing writes today, keeps a key of its own.
    const preferred = savedKey(message, input.sentKeys)
    const key = keys.has(preferred) ? `message:${message.id}` : preferred
    keys.add(key)

    const saved = savedMessage(message, key, authorOf(message.authorPrincipal, input), input)
    const unfinished =
      message.role === "assistant" && message.runId !== null ? ended.get(message.runId) : undefined
    result.push(unfinished ? unfinishedMessage(saved, unfinished) : saved)
  }

  const pending = input.pending
  if (pending && !(pending.messageId !== null && savedIds.has(pending.messageId))) {
    result.push(pendingMessage(pending, input))
  }

  const live = liveReply(input, savedIds, answeredRuns)
  if (live) result.push(live)

  return result
}

const unfinishedEntries = new WeakMap<AgentConversationMessage, AgentConversationMessage>()

/** The same saved reply, marked as one its run ended before finishing; kept stable across renders. */
function unfinishedMessage(
  message: AgentConversationMessage,
  unfinished: "failed" | "cancelled"
): AgentConversationMessage {
  const cached = unfinishedEntries.get(message)
  if (cached?.unfinished === unfinished) return cached
  const marked = { ...message, unfinished }
  unfinishedEntries.set(message, marked)
  return marked
}

function isContinuation(message: AgentMessage): boolean {
  return message.role === "user" && message.parts.some((part) => part.type === "continuation")
}

function savedKey(message: AgentMessage, sentKeys: ReadonlyMap<string, string> | undefined) {
  if (message.role === "assistant" && message.runId !== null) return `run:${message.runId}`

  return sentKeys?.get(message.id) ?? `message:${message.id}`
}

function authorOf(
  principal: { readonly type: AgentPrincipalType; readonly id: string } | undefined,
  input: ConversationMessagesInput
): AgentConversationAuthor | undefined {
  if (!principal) return undefined

  const isReader = Boolean(input.reader && principalKey(input.reader) === principalKey(principal))
  const displayName =
    knownName(principal, input.thread ?? null, input.authors) ??
    (isReader ? input.reader?.displayName : undefined)

  return {
    type: principal.type,
    id: principal.id,
    ...(displayName === undefined ? {} : { displayName }),
    isReader,
  }
}

// Saved messages keep their identity while the live reply streams below them, so the rows that
// draw them are not drawn again on every chunk.
interface SavedEntry {
  readonly key: string
  readonly author: AgentConversationAuthor | undefined
  readonly observed: boolean
  readonly message: AgentConversationMessage
}

const savedEntries = new WeakMap<AgentMessage, SavedEntry>()

function savedMessage(
  message: AgentMessage,
  key: string,
  author: AgentConversationAuthor | undefined,
  input: ConversationMessagesInput
): AgentConversationMessage {
  const observed = Boolean(input.observed)
  const cached = savedEntries.get(message)
  if (
    cached &&
    cached.key === key &&
    cached.observed === observed &&
    sameAuthor(cached.author, author)
  ) {
    return cached.message
  }

  const fileSource = (fileRef: AgentFileRef, path: string) =>
    messageFileSource({
      threadId: message.threadId,
      messageId: message.id,
      path,
      fileRef,
      observed,
    })

  const converted: AgentConversationMessage = {
    key,
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    status: "complete",
    runId: message.runId,
    ...(author ? { author } : {}),
    parts: savedParts(message.parts, fileSource),
    context: message.parts.flatMap((part) =>
      part.type === "context"
        ? [{ context: part.context as AgentContextInput, origin: part.origin }]
        : []
    ),
    diagnostics: message.annotations,
    ...(message.compaction ? { compaction: message.compaction } : {}),
  }

  savedEntries.set(message, { key, author, observed, message: converted })
  return converted
}

function sameAuthor(
  a: AgentConversationAuthor | undefined,
  b: AgentConversationAuthor | undefined
): boolean {
  if (!a || !b) return a === b

  return (
    a.type === b.type &&
    a.id === b.id &&
    a.displayName === b.displayName &&
    a.isReader === b.isReader
  )
}

/**
 * A saved message's parts. Text parts of one step join; a step boundary keeps them apart, as the
 * built-in chat draws them. Step boundaries, context and the model's own state are not parts.
 */
function savedParts(
  parts: AgentMessage["parts"],
  fileSource: (fileRef: AgentFileRef, path: string) => FileSource
): AgentConversationPart[] {
  const result: AgentConversationPart[] = []
  let joinsText = false

  parts.forEach((part, index) => {
    switch (part.type) {
      case "text": {
        const previous = result.at(-1)
        if (joinsText && previous?.type === "text") {
          result[result.length - 1] = { ...previous, text: previous.text + part.text }
        } else {
          result.push({ type: "text", text: part.text, streaming: false })
        }
        joinsText = true
        return
      }

      case "reasoning":
        result.push({ type: "reasoning", text: part.text, streaming: false })
        break

      case "tool-call": {
        const files = toolResultFiles(
          part.state === "output-available" ? part.output : undefined
        ).map(({ fileRef, contentIndex }) => ({
          fileRef,
          source: fileSource(fileRef, `/parts/${index}/output/content/${contentIndex}/fileRef`),
        }))
        const tool: NormalizedTool =
          part.state === "output-available"
            ? { toolName: part.toolName, state: part.state, input: part.input, output: part.output }
            : {
                toolName: part.toolName,
                state: part.state,
                input: part.input,
                errorText: part.errorText,
              }
        result.push({
          type: "tool",
          toolName: part.toolName,
          toolCallId: part.toolCallId,
          ...toolViewProps(tool),
          ...(files.length === 0 ? {} : { files }),
        })
        break
      }

      case "file":
        result.push({
          type: "file",
          fileRef: part.fileRef,
          source: fileSource(part.fileRef, `/parts/${index}/fileRef`),
        })
        break

      case "step-start":
        break

      case "context":
      case "continuation":
      case "approval-outcome":
      case "provider-state":
      // What the parent told a sub-agent: its card shows it, from the parent's own calls.
      case "mail":
        // Not drawn, and no boundary: text on either side reads as one.
        return

      default:
        // Compile error if the core message part union grows: handle the new kind above.
        part satisfies never
        return
    }

    joinsText = false
  })

  return result
}

function pendingMessage(
  pending: PendingUserMessage,
  input: ConversationMessagesInput
): AgentConversationMessage {
  const author = authorOf(input.reader, input)

  return {
    key: pending.key,
    id: null,
    role: "user",
    status: "pending",
    runId: null,
    ...(author ? { author } : {}),
    parts: [
      ...(pending.text ? [{ type: "text" as const, text: pending.text, streaming: false }] : []),
      ...pending.attachments.map((fileRef) => ({ type: "file" as const, fileRef })),
    ],
    context: pending.context,
    diagnostics: [],
  }
}

/** The reply streaming in, until its saved copy is in the conversation. */
function liveReply(
  input: ConversationMessagesInput,
  savedIds: ReadonlySet<string>,
  answeredRuns: ReadonlySet<string>
): AgentConversationMessage | null {
  const live = input.live
  if (!live || live.runId === null || live.parts.length === 0) return null
  if (live.finalizedMessageId !== null && savedIds.has(live.finalizedMessageId)) return null
  if (answeredRuns.has(live.runId)) return null

  // A worker that stopped mid-turn saved none of what it streamed.
  const presentation = input.presentation
  if (presentation.kind === "interrupted" && !presentation.hasProgress) return null

  const unfinished =
    live.finishStatus === "failed" || live.finishStatus === "cancelled"
      ? live.finishStatus
      : undefined

  return {
    key: `run:${live.runId}`,
    id: null,
    role: "assistant",
    // Saved but not read back yet: the reply keeps its live shape until the copy replaces it.
    status: live.active || live.finalizedMessageId !== null ? "streaming" : "complete",
    runId: live.runId,
    parts: liveParts(live),
    context: [],
    diagnostics: [],
    ...(unfinished ? { unfinished } : {}),
  }
}

/** The live parts. Text streams in spans the built-in chat joins, so they join here too. */
function liveParts(live: LiveRunState): AgentConversationPart[] {
  const result: AgentConversationPart[] = []

  live.parts.forEach((part, index) => {
    switch (part.kind) {
      case "text": {
        const previous = result.at(-1)
        if (previous?.type === "text") {
          result[result.length - 1] = { ...previous, text: previous.text + part.text }
        } else {
          result.push({ type: "text", text: part.text, streaming: false })
        }
        return
      }

      case "reasoning":
        result.push({ type: "reasoning", text: part.text, streaming: part.streaming })
        return

      case "tool": {
        const key = live.partKeys[index]
        const toolCallId = key?.startsWith("tool#") ? key.slice("tool#".length) : undefined
        result.push({
          type: "tool",
          toolName: part.tool.toolName,
          ...(toolCallId === undefined ? {} : { toolCallId }),
          ...toolViewProps(part.tool),
          ...(part.tool.files ? { files: part.tool.files.map(fileOf) } : {}),
        })
        return
      }

      case "file":
        result.push({ type: "file", ...fileOf(part) })
        return

      case "step-start":
        return

      default:
        part satisfies never
    }
  })

  // The model is still writing the text it ended on.
  const last = result.at(-1)
  if (live.active && last?.type === "text") {
    result[result.length - 1] = { ...last, streaming: true }
  }

  return result
}

function fileOf(file: NormalizedFile): AgentConversationFile {
  return file.source === undefined
    ? { fileRef: file.fileRef }
    : { fileRef: file.fileRef, source: file.source }
}

/**
 * The parts as the built-in chat draws them. Two text parts in a row were two steps, which the
 * chat keeps apart with the step boundary between them.
 */
export function normalizedParts(parts: readonly AgentConversationPart[]): NormalizedPart[] {
  const result: NormalizedPart[] = []

  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (result.at(-1)?.kind === "text") result.push({ kind: "step-start" })
        result.push({ kind: "text", text: part.text })
        break

      case "reasoning":
        result.push({ kind: "reasoning", text: part.text, streaming: part.streaming })
        break

      case "tool":
        result.push({ kind: "tool", tool: normalizedTool(part) })
        break

      case "file":
        result.push({ kind: "file", ...fileOf(part) })
        break

      default:
        part satisfies never
    }
  }

  return result
}

/** A tool part as the built-in tool views read it. */
export function normalizedTool(part: AgentConversationToolPart): NormalizedTool {
  const { type: _type, toolCallId: _toolCallId, ...tool } = part
  return tool
}

/** What the reader may do with the turn, and what of it is under way. */
interface AgentConversationTurnActions {
  /** `conversation.stop()` stops the answer in flight. */
  readonly canStop: boolean
  /** `conversation.retry()` runs again a turn that never answered. */
  readonly canRetry: boolean
  /** `conversation.continue()` finishes an answer cut short. */
  readonly canContinue: boolean
  readonly stopping: boolean
  readonly retrying: boolean
  readonly continuing: boolean
}

/**
 * The newest turn of the conversation: answering, or how it ended when it ended short. A chat draws
 * its markers from it, such as the thinking shimmer or the notice that an answer timed out.
 */
export type AgentConversationTurn = AgentConversationTurnActions &
  (
    | { readonly kind: "idle" }
    | {
        readonly kind: "responding"
        /** The run answering. Its reply joins `messages` once it streams content. */
        readonly runId: string
        /** The answer has waited in the queue longer than usual. */
        readonly waitingLonger: boolean
        /** The computer the answer waits for, while it is offline. */
        readonly waitingFor: string | null
        /** Earlier turns are being condensed before the answer starts. */
        readonly compacting: boolean
        /** The answer's live stream dropped and is reconnecting. */
        readonly reconnecting: boolean
        /** Who asked for the answer, when it is someone other than the reader. */
        readonly answeringFor: AgentConversationAuthor | null
      }
    /** The turn failed without an answer. One that failed mid-answer says so on its reply. */
    | { readonly kind: "failed" }
    /** The turn hit its time limit. With progress saved it can continue, else run again. */
    | { readonly kind: "timeout"; readonly hasProgress: boolean; readonly timeoutMs?: number }
    /** The worker running the turn stopped. With progress saved it can continue, else run again. */
    | { readonly kind: "interrupted"; readonly hasProgress: boolean }
    /** The turn was stopped without an answer. One stopped mid-answer says so on its reply. */
    | { readonly kind: "cancelled" }
  )

export interface ConversationTurnInput extends AgentConversationTurnActions {
  readonly presentation: ActiveTurnPresentation
  readonly activeRunId: string | null
  readonly waitingLonger: boolean
  /** The offline computer a conversation that runs on one waits for. */
  readonly waitingFor: string | null
  readonly compacting: boolean
  readonly reconnecting: boolean
  readonly answeringFor: AgentConversationAuthor | null
}

export function conversationTurn(input: ConversationTurnInput): AgentConversationTurn {
  const { presentation } = input
  const actions: AgentConversationTurnActions = {
    canStop: input.canStop,
    canRetry: input.canRetry,
    canContinue: input.canContinue,
    stopping: input.stopping,
    retrying: input.retrying,
    continuing: input.continuing,
  }

  switch (presentation.kind) {
    case "responding":
      // A turn responds only while a run is followed.
      if (input.activeRunId === null) return { ...actions, kind: "idle" }

      return {
        ...actions,
        kind: "responding",
        runId: input.activeRunId,
        // Set while the wait is the queue's, before the run starts.
        waitingLonger: presentation.queuedRun !== null && input.waitingLonger,
        waitingFor: presentation.queuedRun !== null ? input.waitingFor : null,
        compacting: input.compacting,
        reconnecting: input.reconnecting,
        answeringFor: input.answeringFor,
      }

    case "timeout":
      return {
        ...actions,
        kind: "timeout",
        hasProgress: presentation.hasProgress,
        ...(presentation.timeoutMs === undefined ? {} : { timeoutMs: presentation.timeoutMs }),
      }

    case "interrupted":
      return { ...actions, kind: "interrupted", hasProgress: presentation.hasProgress }

    case "failed":
    case "cancelled":
    case "idle":
      return { ...actions, kind: presentation.kind }

    default:
      presentation satisfies never
      return { ...actions, kind: "idle" }
  }
}

/** A conversation read without acting on it, as an observer does. */
export const READ_ONLY_TURN = {
  canStop: false,
  canRetry: false,
  canContinue: false,
  stopping: false,
  retrying: false,
  continuing: false,
  waitingLonger: false,
  waitingFor: null,
  compacting: false,
  reconnecting: false,
  answeringFor: null,
} as const satisfies Omit<ConversationTurnInput, "presentation" | "activeRunId">
