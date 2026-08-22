import type { AgentRunStreamEvent } from "@sixb/client"
import type { NormalizedPart, NormalizedTool } from "./parts"
import type { AgentRunStatus } from "./types"

export interface LiveRunState {
  /** The run this state belongs to, or null when idle. */
  readonly runId: string | null
  /** True once `agent.run.started` arrives and the run has not finished. */
  readonly active: boolean
  /** Ordered, render-ready parts of the in-flight assistant message, in first-chunk order. */
  readonly parts: readonly NormalizedPart[]
  /**
   * Internal bookkeeping, index-aligned with `parts`: the identity each part is merged on as more
   * chunks arrive (text/reasoning by id within a step, tools by their global call id). Not meant for
   * rendering — the view consumes `parts` directly.
   */
  readonly partKeys: readonly string[]
  /** AI SDK model step currently being streamed. Used to keep reused part ids ordered. */
  readonly stepIndex?: number
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
    partKeys: [],
    stepIndex: 0,
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
      return { ...state, runId: event.runId, active: true }
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
    case "start-step":
      return { ...state, stepIndex: liveStepIndex(state) + 1 }
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
  const key = spanKey("text", id, liveStepIndex(state))
  const existingIndex = state.partKeys.indexOf(key)

  // Start/end lifecycle chunks carry no content. Likewise, do not let leading whitespace create a
  // placeholder row; once a real span exists, whitespace deltas remain significant between words.
  if (!delta || (existingIndex === -1 && !delta.trim())) return state

  return upsertPart(
    state,
    key,
    () => ({ kind: "text", text: delta }),
    (part) => (part.kind === "text" ? { kind: "text", text: part.text + delta } : part)
  )
}

function reduceReasoning(state: LiveRunState, chunk: Record<string, unknown>): LiveRunState {
  const id = typeof chunk.id === "string" ? chunk.id : "reasoning"
  const delta = typeof chunk.delta === "string" ? chunk.delta : ""
  const done = chunk.type === "reasoning-end"
  return upsertPart(
    state,
    spanKey("reasoning", id, liveStepIndex(state)),
    () => ({ kind: "reasoning", text: delta, streaming: !done }),
    (part) =>
      part.kind === "reasoning"
        ? { kind: "reasoning", text: part.text + delta, streaming: part.streaming && !done }
        : part
  )
}

function reduceTool(state: LiveRunState, chunk: Record<string, unknown>): LiveRunState {
  const toolCallId = typeof chunk.toolCallId === "string" ? chunk.toolCallId : null
  if (!toolCallId) return state
  const toolName = typeof chunk.toolName === "string" ? chunk.toolName : undefined

  return upsertPart(
    state,
    // Tool call ids are globally unique, so a call is matched across steps by id alone.
    `tool#${toolCallId}`,
    () => ({
      kind: "tool",
      tool: applyToolChunk(
        { toolName: toolName ?? "tool", state: "input-streaming", inputText: "" },
        chunk
      ),
    }),
    (part) =>
      part.kind === "tool"
        ? {
            kind: "tool",
            tool: applyToolChunk({ ...part.tool, ...(toolName ? { toolName } : {}) }, chunk),
          }
        : part
  )
}

function applyToolChunk(tool: NormalizedTool, chunk: Record<string, unknown>): NormalizedTool {
  switch (chunk.type) {
    case "tool-input-start":
      return { ...tool, state: "input-streaming" }
    case "tool-input-delta":
      return {
        ...tool,
        inputText:
          (tool.inputText ?? "") +
          (typeof chunk.inputTextDelta === "string" ? chunk.inputTextDelta : ""),
        state: "input-streaming",
      }
    case "tool-input-available":
      return { ...tool, state: "input-available", input: chunk.input }
    case "tool-input-error":
      return {
        ...tool,
        state: "output-error",
        input: chunk.input,
        errorText: typeof chunk.errorText === "string" ? chunk.errorText : "Tool input error.",
      }
    case "tool-output-available":
      return { ...tool, state: "output-available", output: chunk.output }
    case "tool-output-error":
      return {
        ...tool,
        state: "output-error",
        errorText: typeof chunk.errorText === "string" ? chunk.errorText : "Tool error.",
      }
    default:
      return tool
  }
}

// Append a new part when its key is unseen, otherwise merge into the matching one in place —
// preserving order. `partKeys` stays index-aligned with `parts`.
function upsertPart(
  state: LiveRunState,
  key: string,
  create: () => NormalizedPart,
  update: (part: NormalizedPart) => NormalizedPart
): LiveRunState {
  const index = state.partKeys.indexOf(key)
  if (index === -1) {
    return { ...state, parts: [...state.parts, create()], partKeys: [...state.partKeys, key] }
  }
  const parts = state.parts.slice()
  parts[index] = update(parts[index] as NormalizedPart)
  return { ...state, parts }
}

// The identity a text/reasoning span merges on: the same id reused in a later step is a new part.
function spanKey(kind: "text" | "reasoning", id: string, stepIndex: number): string {
  return `${kind}#${stepIndex}#${id}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function liveStepIndex(state: LiveRunState): number {
  return state.stepIndex ?? 0
}
