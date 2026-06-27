import type { AgentRunStreamEvent } from "@sixb/client"
import type { AgentRunStatus } from "./types"

// A single piece of the in-flight assistant message, reconstructed from `agent.ui.chunk` events.
// Mirrors the durable `AgentMessagePart` shapes, but kept separate because live chunks arrive as
// deltas keyed by id/toolCallId and must be merged incrementally.
export type LivePart =
  | { readonly kind: "text"; readonly id: string; text: string }
  | { readonly kind: "reasoning"; readonly id: string; text: string; done: boolean }
  | {
      readonly kind: "tool"
      readonly id: string
      toolName: string
      state: "input-streaming" | "input-available" | "output-available" | "output-error"
      inputText: string
      input?: unknown
      output?: unknown
      errorText?: string
    }

export interface LiveRunState {
  /** The run this state belongs to, or null when idle. */
  readonly runId: string | null
  /** True once `agent.run.started` arrives and the run has not finished. */
  readonly active: boolean
  readonly modelId?: string
  /** Ordered live parts, in the order their first chunk arrived. */
  readonly parts: readonly LivePart[]
  /** Set once the worker persists the assistant message; the hook reloads durable state on change. */
  readonly finalizedMessageId: string | null
  /** Terminal run status, or null while in-flight. */
  readonly finishStatus: AgentRunStatus | null
  /** Error text from a failed run. */
  readonly finishError: string | null
  /** Error text surfaced by a stream `error` chunk (not necessarily fatal). */
  readonly streamError: string | null
}

export type LiveRunAction =
  | { readonly type: "reset"; readonly runId: string | null }
  | { readonly type: "event"; readonly event: AgentRunStreamEvent }
  | { readonly type: "stream-error"; readonly message: string }

export function createLiveRunState(runId: string | null = null): LiveRunState {
  return {
    runId,
    active: false,
    parts: [],
    finalizedMessageId: null,
    finishStatus: null,
    finishError: null,
    streamError: null,
  }
}

/** True when there is no visible streamed content yet — the moment to show a "thinking" shimmer. */
export function isAwaitingFirstToken(state: LiveRunState): boolean {
  return state.active && state.parts.length === 0
}

/** True when the live row has anything worth rendering for the given run. */
export function hasLiveContent(state: LiveRunState, runId: string | null): boolean {
  if (!runId || state.runId !== runId) return false
  return state.active || state.parts.length > 0 || state.finishStatus === "failed"
}

export function liveRunReducer(state: LiveRunState, action: LiveRunAction): LiveRunState {
  switch (action.type) {
    case "reset":
      return createLiveRunState(action.runId)
    case "stream-error":
      return { ...state, streamError: action.message }
    case "event":
      return reduceEvent(state, action.event)
    default:
      return state
  }
}

function reduceEvent(state: LiveRunState, event: AgentRunStreamEvent): LiveRunState {
  switch (event.type) {
    case "agent.run.started":
      return {
        ...state,
        runId: event.runId,
        active: true,
        ...(event.modelId === undefined ? {} : { modelId: event.modelId }),
      }
    case "agent.ui.chunk":
      return applyChunk(state, event.chunk)
    case "agent.message.finalized":
      return { ...state, finalizedMessageId: event.messageId }
    case "agent.run.finished":
      return {
        ...state,
        active: false,
        finishStatus: event.status,
        finishError: event.error ?? null,
      }
    default:
      return state
  }
}

// Reduce an AI SDK `UIMessageChunk` (typed as opaque JSON on the wire). Unknown shapes are ignored
// so the stream stays alive even if the SDK emits chunk variants this UI does not model yet.
function applyChunk(state: LiveRunState, chunk: unknown): LiveRunState {
  if (!isRecord(chunk) || typeof chunk.type !== "string") return state

  switch (chunk.type) {
    case "text-start":
    case "text-delta":
    case "text-end":
      return reduceText(state, chunk)
    case "reasoning-start":
    case "reasoning-delta":
    case "reasoning-end":
      return reduceReasoning(state, chunk)
    case "tool-input-start":
    case "tool-input-delta":
    case "tool-input-available":
    case "tool-input-error":
    case "tool-output-available":
    case "tool-output-error":
      return reduceTool(state, chunk)
    case "error":
      return typeof chunk.errorText === "string"
        ? { ...state, streamError: chunk.errorText }
        : state
    default:
      return state
  }
}

function reduceText(state: LiveRunState, chunk: Record<string, unknown>): LiveRunState {
  const id = typeof chunk.id === "string" ? chunk.id : "text"
  const delta = typeof chunk.delta === "string" ? chunk.delta : ""
  return upsertPart(
    state,
    (part): part is Extract<LivePart, { kind: "text" }> => part.kind === "text" && part.id === id,
    () => ({ kind: "text", id, text: delta }),
    (part) => (delta ? { ...part, text: part.text + delta } : part)
  )
}

function reduceReasoning(state: LiveRunState, chunk: Record<string, unknown>): LiveRunState {
  const id = typeof chunk.id === "string" ? chunk.id : "reasoning"
  const delta = typeof chunk.delta === "string" ? chunk.delta : ""
  const done = chunk.type === "reasoning-end"
  return upsertPart(
    state,
    (part): part is Extract<LivePart, { kind: "reasoning" }> =>
      part.kind === "reasoning" && part.id === id,
    () => ({ kind: "reasoning", id, text: delta, done }),
    (part) => ({ ...part, text: part.text + delta, done: done || part.done })
  )
}

function reduceTool(state: LiveRunState, chunk: Record<string, unknown>): LiveRunState {
  const id = typeof chunk.toolCallId === "string" ? chunk.toolCallId : null
  if (!id) return state
  const toolName = typeof chunk.toolName === "string" ? chunk.toolName : undefined

  return upsertPart(
    state,
    (part): part is Extract<LivePart, { kind: "tool" }> => part.kind === "tool" && part.id === id,
    () => {
      const base: Extract<LivePart, { kind: "tool" }> = {
        kind: "tool",
        id,
        toolName: toolName ?? "tool",
        inputText: "",
        state: "input-streaming",
      }
      return { ...base, ...applyToolChunk(base, chunk) }
    },
    (part) => ({ ...part, ...(toolName ? { toolName } : {}), ...applyToolChunk(part, chunk) })
  )
}

type ToolPartFields = Partial<Omit<Extract<LivePart, { kind: "tool" }>, "kind" | "id">> & {
  inputText: string
}

function applyToolChunk(
  part: { inputText: string },
  chunk: Record<string, unknown>
): ToolPartFields {
  switch (chunk.type) {
    case "tool-input-start":
      return { inputText: part.inputText, state: "input-streaming" }
    case "tool-input-delta":
      return {
        inputText:
          part.inputText + (typeof chunk.inputTextDelta === "string" ? chunk.inputTextDelta : ""),
        state: "input-streaming",
      }
    case "tool-input-available":
      return { inputText: part.inputText, state: "input-available", input: chunk.input }
    case "tool-input-error":
      return {
        inputText: part.inputText,
        state: "output-error",
        input: chunk.input,
        errorText: typeof chunk.errorText === "string" ? chunk.errorText : "Tool input error.",
      }
    case "tool-output-available":
      return { inputText: part.inputText, state: "output-available", output: chunk.output }
    case "tool-output-error":
      return {
        inputText: part.inputText,
        state: "output-error",
        errorText: typeof chunk.errorText === "string" ? chunk.errorText : "Tool error.",
      }
    default:
      return { inputText: part.inputText }
  }
}

// Append a new part if none matches, otherwise replace the matching one in place — preserving order.
function upsertPart<T extends LivePart>(
  state: LiveRunState,
  match: (part: LivePart) => part is T,
  create: () => T,
  update: (part: T) => T
): LiveRunState {
  const index = state.parts.findIndex(match)
  if (index === -1) {
    return { ...state, parts: [...state.parts, create()] }
  }
  const next = state.parts.slice()
  next[index] = update(state.parts[index] as T)
  return { ...state, parts: next }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
