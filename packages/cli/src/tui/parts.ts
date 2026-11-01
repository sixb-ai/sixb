import type {
  AgentRunStreamEvent,
  ListAgentThreadMessagesResponses,
  ModelUiChunk,
} from "@sixb/client"

// What a message shows, whether it was stored or is still streaming: the stored transcript and the
// live run both reduce to these parts, so one view renders either.

export type StoredMessage = ListAgentThreadMessagesResponses[200]["messages"][number]

export type ToolState = "running" | "done" | "error"

export type Part =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string; readonly done: boolean }
  | {
      readonly kind: "tool"
      readonly id: string
      readonly name: string
      readonly state: ToolState
      readonly input?: unknown
      /** The input while the model still writes it, as JSON text. */
      readonly inputText?: string
      readonly output?: unknown
      readonly error?: string
    }
  | { readonly kind: "file"; readonly name: string; readonly mediaType?: string }

type ApprovalOutcomePart = Extract<StoredMessage["parts"][number], { type: "approval-outcome" }>

/** How a held call ended, as the message that resumed or followed its turn told the agent. */
export interface ApprovalOutcome {
  readonly approvalId: string
  readonly status: ApprovalOutcomePart["status"]
  readonly outcome?: ApprovalOutcomePart["outcome"]
}

export interface ShownMessage {
  readonly id: string
  readonly role: "user" | "assistant"
  readonly runId: string | null
  readonly parts: readonly Part[]
  /** How the held calls before it ended: not shown, but the calls' own lines say it. */
  readonly outcomes: readonly ApprovalOutcome[]
  /** Its run condensed the conversation first; `contextFull` when the provider refused it whole. */
  readonly compaction?: { readonly contextFull: boolean }
  readonly createdAt: string
}

/** A stored message as shown: what is context for the agent alone stays hidden. */
export function shownMessage(message: StoredMessage): ShownMessage | null {
  if (message.role === "system") return null

  const outcomes = message.parts.flatMap((part): ApprovalOutcome[] =>
    part.type === "approval-outcome"
      ? [
          {
            approvalId: part.approvalId,
            status: part.status,
            ...(part.outcome === undefined ? {} : { outcome: part.outcome }),
          },
        ]
      : []
  )

  const parts = message.parts.flatMap((part): Part[] => {
    switch (part.type) {
      case "text":
        return part.text.trim() ? [{ kind: "text", text: part.text }] : []
      case "reasoning":
        return part.text.trim() ? [{ kind: "reasoning", text: part.text, done: true }] : []
      case "tool-call":
        return [
          part.state === "output-available"
            ? {
                kind: "tool",
                id: part.toolCallId,
                name: part.toolName,
                state: "done",
                input: part.input,
                output: part.output,
              }
            : {
                kind: "tool",
                id: part.toolCallId,
                name: part.toolName,
                state: "error",
                input: part.input,
                error: part.errorText,
              },
        ]
      case "file":
        return [
          {
            kind: "file",
            name: part.fileRef.fileName ?? "file",
            ...(part.fileRef.mediaType === undefined ? {} : { mediaType: part.fileRef.mediaType }),
          },
        ]
      default:
        return []
    }
  })
  // A turn resumed after approvals starts from a message the person never wrote: it shows
  // nothing, and is kept for how its held calls ended.
  if (message.role === "user" && parts.length === 0 && outcomes.length === 0) return null
  return {
    id: message.id,
    role: message.role,
    runId: message.runId,
    parts,
    outcomes,
    ...(message.compaction
      ? { compaction: { contextFull: message.compaction.reason === "overflow" } }
      : {}),
    createdAt: message.createdAt,
  }
}

/** How each held call of a transcript ended, by its approval's id. */
export function approvalOutcomes(
  messages: readonly ShownMessage[]
): ReadonlyMap<string, ApprovalOutcome> {
  return new Map(
    messages.flatMap((message) => message.outcomes.map((outcome) => [outcome.approvalId, outcome]))
  )
}

/** A run as it streams: its parts so far, and whether it still works. */
export interface LiveRun {
  readonly runId: string
  readonly parts: readonly Part[]
  readonly keys: readonly string[]
  readonly step: number
  /** How many parts came before the current step: a step asked again drops the ones after. */
  readonly stepStart: number
  readonly working: boolean
  readonly compacting: boolean
  /** The condensing follows a request the provider refused as too long: the turn goes on after. */
  readonly contextFull: boolean
  /** Set once the run's answer is stored: the transcript then shows it. */
  readonly finalized: boolean
  readonly finished?: { readonly status: string; readonly error?: string }
}

export function liveRun(runId: string): LiveRun {
  return {
    runId,
    parts: [],
    keys: [],
    step: 0,
    stepStart: 0,
    working: true,
    compacting: false,
    contextFull: false,
    finalized: false,
  }
}

export function reduceLive(state: LiveRun, event: AgentRunStreamEvent): LiveRun {
  switch (event.type) {
    case "agent.run.started":
      return { ...state, working: true }
    case "agent.compaction.started":
      return { ...state, compacting: true, contextFull: event.reason === "overflow" }
    case "agent.compaction.completed":
    case "agent.compaction.failed":
      return { ...state, compacting: false, contextFull: false }
    case "agent.ui.chunk":
      return reduceChunk(state, event.chunk)
    case "agent.message.finalized":
      return { ...state, finalized: true }
    case "agent.run.finished":
      return {
        ...state,
        working: false,
        compacting: false,
        contextFull: false,
        finished: {
          status: event.status,
          ...(event.error ? { error: event.error.message } : {}),
        },
      }
    default:
      return state
  }
}

function reduceChunk(state: LiveRun, chunk: ModelUiChunk): LiveRun {
  switch (chunk.type) {
    case "start-step":
      // A step asked again drops what its first call streamed.
      if (chunk.retry) {
        return {
          ...state,
          parts: state.parts.slice(0, state.stepStart),
          keys: state.keys.slice(0, state.stepStart),
        }
      }
      return { ...state, step: state.step + 1, stepStart: state.parts.length }
    case "text-delta": {
      if (!chunk.delta) return state
      const key = `text#${state.step}#${chunk.id}`
      if (!state.keys.includes(key) && !chunk.delta.trim()) return state
      return upsert(state, key, { kind: "text", text: chunk.delta }, (part) =>
        part.kind === "text" ? { ...part, text: part.text + chunk.delta } : part
      )
    }
    case "reasoning-delta":
      return upsert(
        state,
        `reasoning#${state.step}#${chunk.id}`,
        { kind: "reasoning", text: chunk.delta, done: false },
        (part) => (part.kind === "reasoning" ? { ...part, text: part.text + chunk.delta } : part)
      )
    case "reasoning-end":
      return upsert(
        state,
        `reasoning#${state.step}#${chunk.id}`,
        { kind: "reasoning", text: "", done: true },
        (part) => (part.kind === "reasoning" ? { ...part, done: true } : part)
      )
    case "tool-input-start":
    case "tool-input-delta":
    case "tool-input-available":
    case "tool-input-error":
    case "tool-output-available":
    case "tool-output-error": {
      const created: Part = {
        kind: "tool",
        id: chunk.toolCallId,
        name: "toolName" in chunk && chunk.toolName ? chunk.toolName : "tool",
        state: "running",
      }
      return upsert(state, `tool#${chunk.toolCallId}`, created, (part) =>
        part.kind === "tool" ? applyToolChunk(part, chunk) : part
      )
    }
    default:
      return state
  }
}

type ToolPart = Extract<Part, { readonly kind: "tool" }>

function applyToolChunk(part: ToolPart, chunk: ModelUiChunk): ToolPart {
  const named = "toolName" in chunk && chunk.toolName ? { ...part, name: chunk.toolName } : part
  switch (chunk.type) {
    case "tool-input-delta":
      return { ...named, inputText: (named.inputText ?? "") + chunk.inputTextDelta }
    case "tool-input-available":
      return { ...named, input: chunk.input }
    case "tool-input-error":
      return { ...named, state: "error", input: chunk.input, error: chunk.errorText }
    case "tool-output-available":
      return { ...named, state: "done", output: chunk.output }
    case "tool-output-error":
      return { ...named, state: "error", error: chunk.errorText }
    default:
      return named
  }
}

/** Append a part under a new key, or change the one already there, keeping their order. */
function upsert(state: LiveRun, key: string, created: Part, update: (part: Part) => Part): LiveRun {
  const index = state.keys.indexOf(key)
  if (index === -1) {
    return { ...state, parts: [...state.parts, created], keys: [...state.keys, key] }
  }
  const parts = state.parts.slice()
  parts[index] = update(parts[index] as Part)
  return { ...state, parts }
}
