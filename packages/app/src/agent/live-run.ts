import type { AgentRunFailure, AgentRunStreamEvent, ModelUiChunk } from "@sixb/client"
import type { NormalizedPart, NormalizedTool } from "./parts"
import type { AgentRunStatus } from "./types"

export interface LiveRunState {
  /** The run this state belongs to, or null when idle. */
  readonly runId: string | null
  /** True once `agent.run.started` arrives and the run has not finished. */
  readonly active: boolean
  /** True while the worker is condensing earlier turns before the normal model call. */
  readonly compacting: boolean
  /** The condensing follows a request the provider refused as too long: the turn goes on after. */
  readonly contextFull: boolean
  /** Ordered, render-ready parts of the in-flight assistant message, in first-chunk order. */
  readonly parts: readonly NormalizedPart[]
  /**
   * Internal bookkeeping, index-aligned with `parts`: the identity each part is merged on as more
   * chunks arrive (text/reasoning by id within a step, tools by their global call id). Not meant for
   * rendering — the view consumes `parts` directly.
   */
  readonly partKeys: readonly string[]
  /** Model step currently being streamed. Used to keep reused part ids ordered. */
  readonly stepIndex: number
  /** How many parts came before the current step: a step asked again drops the ones after. */
  readonly stepStart: number
  /** Set once the worker persists the assistant message; the hook reloads durable state on change. */
  readonly finalizedMessageId: string | null
  /** Terminal run status, or null while in-flight. */
  readonly finishStatus: AgentRunStatus | null
  /** Stable reason the run ended, when the terminal event supplies one. */
  readonly finishReason: string | null
  /** Exact durable failure from a failed or cancelled run. */
  readonly finishError: AgentRunFailure | null
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
    compacting: false,
    contextFull: false,
    parts: [],
    partKeys: [],
    stepIndex: 0,
    stepStart: 0,
    finalizedMessageId: null,
    finishStatus: null,
    finishReason: null,
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
    case "agent.compaction.started":
      return {
        ...state,
        runId: event.runId,
        active: true,
        compacting: true,
        contextFull: event.reason === "overflow",
      }
    case "agent.compaction.completed":
    case "agent.compaction.failed":
      return { ...state, compacting: false, contextFull: false }
    case "agent.ui.chunk":
      return applyChunk(state, event.chunk)
    case "agent.message.finalized":
      return { ...state, finalizedMessageId: event.messageId }
    case "agent.run.finished":
      return {
        ...state,
        active: false,
        compacting: false,
        contextFull: false,
        finishStatus: event.status,
        finishReason: event.finishReason ?? null,
        finishError: event.error ?? null,
      }
    default:
      return state
  }
}

type TextChunk = Extract<ModelUiChunk, { readonly type: "text-start" | "text-delta" | "text-end" }>
type ReasoningChunk = Extract<
  ModelUiChunk,
  { readonly type: "reasoning-start" | "reasoning-delta" | "reasoning-end" }
>
type ToolChunk = Extract<ModelUiChunk, { readonly toolCallId: string }>

// The client drops chunk types it does not know, so they never reach this reducer.
function applyChunk(state: LiveRunState, chunk: ModelUiChunk): LiveRunState {
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
      // A step asked again drops what its first call streamed.
      if (chunk.retry) {
        return {
          ...state,
          parts: state.parts.slice(0, state.stepStart),
          partKeys: state.partKeys.slice(0, state.stepStart),
        }
      }
      return { ...state, stepIndex: state.stepIndex + 1, stepStart: state.parts.length }
    case "tool-input-start":
    case "tool-input-delta":
    case "tool-input-available":
    case "tool-input-error":
    case "tool-output-available":
    case "tool-output-error":
      return reduceTool(state, chunk)
    case "error":
      return { ...state, streamError: chunk.errorText }
    default:
      return state
  }
}

function reduceText(state: LiveRunState, chunk: TextChunk): LiveRunState {
  const delta = chunk.type === "text-delta" ? chunk.delta : ""
  const key = spanKey("text", chunk.id, state.stepIndex)
  const existingIndex = state.partKeys.indexOf(key)

  // Start/end lifecycle chunks carry no content. Likewise, do not let leading whitespace create a
  // placeholder row; once a real span exists, whitespace deltas remain significant between words.
  if (!delta || (existingIndex === -1 && !delta.trim())) return state

  return upsertPart(
    state,
    key,
    () => ({ kind: "text", text: delta }),
    (part) => (part.kind === "text" ? { kind: "text", text: part.text + delta } : part),
    existingIndex
  )
}

function reduceReasoning(state: LiveRunState, chunk: ReasoningChunk): LiveRunState {
  const delta = chunk.type === "reasoning-delta" ? chunk.delta : ""
  const done = chunk.type === "reasoning-end"
  return upsertPart(
    state,
    spanKey("reasoning", chunk.id, state.stepIndex),
    () => ({ kind: "reasoning", text: delta, streaming: !done }),
    (part) =>
      part.kind === "reasoning"
        ? { kind: "reasoning", text: part.text + delta, streaming: part.streaming && !done }
        : part
  )
}

function reduceTool(state: LiveRunState, chunk: ToolChunk): LiveRunState {
  const { toolCallId, toolName } = chunk
  if (!toolCallId) return state

  return upsertPart(
    state,
    // Tool call ids are globally unique, so a call is matched across steps by id alone.
    `tool#${toolCallId}`,
    () => ({
      kind: "tool",
      tool: applyToolChunk({ toolName, state: "input-streaming", inputText: "" }, chunk),
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

function applyToolChunk(tool: NormalizedTool, chunk: ToolChunk): NormalizedTool {
  switch (chunk.type) {
    case "tool-input-start":
      return { ...tool, state: "input-streaming" }
    case "tool-input-delta":
      return {
        ...tool,
        inputText: (tool.inputText ?? "") + chunk.inputTextDelta,
        state: "input-streaming",
      }
    case "tool-input-available":
      return { ...tool, state: "input-available", input: chunk.input }
    case "tool-input-error":
      return {
        ...tool,
        state: "output-error",
        input: chunk.input,
        errorText: chunk.errorText,
      }
    case "tool-output-available":
      return { ...tool, state: "output-available", output: chunk.output }
    case "tool-output-error":
      return { ...tool, state: "output-error", errorText: chunk.errorText }
  }
}

// Append a new part when its key is unseen, otherwise merge into the matching one in place —
// preserving order. `partKeys` stays index-aligned with `parts`.
function upsertPart(
  state: LiveRunState,
  key: string,
  create: () => NormalizedPart,
  update: (part: NormalizedPart) => NormalizedPart,
  index = state.partKeys.indexOf(key)
): LiveRunState {
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
