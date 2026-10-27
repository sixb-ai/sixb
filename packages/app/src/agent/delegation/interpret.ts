import type { AgentChild } from "@sixb/client"
import { type AgentConversationMessage, normalizedTool } from "../conversation"
import type { AgentMessages } from "../i18n/en"
import { type NormalizedPart, type NormalizedTool, toolResultValue } from "../parts"

// What the parent's own parts say about the sub-agents it delegated to: which it spawned, what it
// told or answered each, and what each asked. A reader of the thread always has them, even without
// access to the children themselves, such as in a fork of someone else's conversation.

export type { AgentChild }

export type AgentChildRun = AgentChild["runs"][number]

/** A child as its `spawn_agent` call names it. `id` is the run the call answered with. */
export interface SpawnedChild {
  /** Its first run's id, or `pending:<key>` while the call is still being made. */
  readonly id: string
  readonly key: string
  readonly task: string
  /** The model the call answered with, once it did. */
  readonly model?: { readonly provider: string; readonly modelId: string }
  /** The tier the Agent asked for, when it asked for one. */
  readonly tier?: string
  readonly pending: boolean
}

/** One line of what passed between the Agent and a child, oldest first. */
export interface ChildExchange {
  readonly kind: "told" | "asked" | "answered"
  readonly text: string
}

/** What `wait_agent` last said about one of a child's runs. */
export interface WaitedChild {
  readonly status: string
  readonly text?: string
  readonly error?: string
}

/** Everything the thread's parts say about its sub-agents, by the id of each one's first run. */
export interface ThreadDelegation {
  /** The turn that spawned each child. */
  readonly spawnedBy: ReadonlyMap<string, string | null>
  readonly exchanges: ReadonlyMap<string, readonly ChildExchange[]>
  /** By the id of the run waited on: a child's first run, or one that continued it. */
  readonly waited: ReadonlyMap<string, WaitedChild>
  /**
   * The child a key named in a turn: the latest spawned under it by then. A call a child made is
   * filed on the turn that ran it, under its key.
   */
  readonly ownerOf: (key: string, runId?: string) => string | undefined
}

/** The child a `spawn_agent` call starts, from its input and, once it answered, its output. */
export function spawnedChild(tool: NormalizedTool): SpawnedChild | null {
  if (tool.toolName !== "spawn_agent" || tool.state === "output-error") return null

  const input = isRecord(tool.input) ? tool.input : {}
  const key = typeof input.key === "string" ? input.key.trim() : ""
  if (!key) return null

  const task = typeof input.task === "string" ? input.task.trim() : ""
  const tier = typeof input.model === "string" ? input.model : undefined
  const output = tool.state === "output-available" ? toolResultValue(tool.output) : undefined
  const runId = isRecord(output) && typeof output.runId === "string" ? output.runId : undefined
  const model = isRecord(output) ? modelRef(output.model) : undefined

  return {
    id: runId ?? `pending:${key}`,
    key,
    task,
    ...(model ? { model } : {}),
    ...(tier ? { tier } : {}),
    pending: runId === undefined,
  }
}

/** The children a run of work spawned, once each, in the order the Agent spawned them. */
export function spawnedChildren(parts: readonly NormalizedPart[]): readonly SpawnedChild[] {
  const seen = new Set<string>()
  return parts.flatMap((part) => {
    if (part.kind !== "tool") return []
    const child = spawnedChild(part.tool)
    if (!child || seen.has(child.id) || seen.has(`pending:${child.key}`)) return []
    seen.add(child.id)
    return [child]
  })
}

/** A turn's delegation calls: the tools that spawn, wait for or message a child. */
export interface DelegationTurn {
  readonly runId: string | null
  readonly tools: readonly NormalizedTool[]
}

const DELEGATION_TOOLS = new Set(["spawn_agent", "wait_agent", "message_agent"])

/** The delegation calls of each reply, oldest first, the one streaming last. */
export function delegationTurns(
  messages: readonly AgentConversationMessage[]
): readonly DelegationTurn[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return []
    const tools = message.parts.flatMap((part) =>
      part.type === "tool" && DELEGATION_TOOLS.has(part.toolName) ? [normalizedTool(part)] : []
    )
    return [{ runId: message.runId, tools }]
  })
}

/**
 * Read the thread's sub-agents from its turns, oldest first, the one streaming now last. Each
 * `message_agent` and question goes to the child its key named at that point.
 */
export function readThreadDelegation(turns: readonly DelegationTurn[]): ThreadDelegation {
  const spawnedBy = new Map<string, string | null>()
  const exchanges = new Map<string, ChildExchange[]>()
  const waited = new Map<string, WaitedChild>()
  const owners = new Map<string, string>()
  const ownersByTurn = new Map<string, ReadonlyMap<string, string>>()

  const add = (key: string, exchange: ChildExchange) => {
    const owner = owners.get(key)
    if (!owner) return
    const list = exchanges.get(owner) ?? []
    // A question is listed by every wait until it is answered: it reads once.
    const repeated = list.some(
      (earlier) => earlier.kind === exchange.kind && earlier.text === exchange.text
    )
    if (exchange.kind === "asked" && repeated) return
    exchanges.set(owner, [...list, exchange])
  }

  const read = (runId: string | null, tool: NormalizedTool) => {
    const child = spawnedChild(tool)
    if (child && !child.pending) {
      spawnedBy.set(child.id, runId)
      owners.set(child.key, child.id)
      return
    }

    if (tool.toolName === "message_agent" && tool.state === "output-available") {
      const input = isRecord(tool.input) ? tool.input : {}
      const output = toolResultValue(tool.output)
      if (typeof input.key !== "string" || typeof input.text !== "string") return
      const kind = isRecord(output) && output.delivery === "answer" ? "answered" : "told"
      add(input.key.trim(), { kind, text: input.text.trim() })
      return
    }

    if (tool.toolName !== "wait_agent" || tool.state !== "output-available") return
    const output = toolResultValue(tool.output)
    if (!isRecord(output)) return

    for (const question of Array.isArray(output.questions) ? output.questions : []) {
      if (!isRecord(question)) continue
      if (typeof question.key !== "string" || typeof question.text !== "string") continue
      add(question.key, { kind: "asked", text: question.text.trim() })
    }
    for (const result of Array.isArray(output.results) ? output.results : []) {
      if (!isRecord(result) || typeof result.runId !== "string") continue
      if (typeof result.status !== "string") continue
      waited.set(result.runId, {
        status: result.status,
        ...(typeof result.text === "string" ? { text: result.text } : {}),
        ...(isRecord(result.error) && typeof result.error.message === "string"
          ? { error: result.error.message }
          : {}),
      })
    }
  }

  for (const turn of turns) {
    for (const tool of turn.tools) read(turn.runId, tool)
    if (turn.runId) ownersByTurn.set(turn.runId, new Map(owners))
  }

  return {
    spawnedBy,
    exchanges,
    waited,
    ownerOf: (key, runId) =>
      (runId ? ownersByTurn.get(runId) : undefined)?.get(key) ?? owners.get(key),
  }
}

/** Where a child stands, as its card says it. */
export type ChildState =
  | "starting"
  | "working"
  | "asking"
  | "approval"
  | "answer"
  | "resume"
  | "done"
  | "failed"
  | "stopped"
  | "ended"
  | "unknown"

/** A child at work, or about to be: its card streams it. */
export function isActive(state: ChildState): boolean {
  return state === "starting" || state === "working" || state === "asking"
}

/**
 * Where a child stands: from its view when the reader has it, else from the parent's parts. `asking`
 * is a child at work that waits on its question to the Agent.
 */
export function childState(input: {
  readonly view?: AgentChild
  readonly spawned?: SpawnedChild
  readonly waited?: WaitedChild
  readonly asking?: boolean
  /** Its turn is streaming now: a child it spawned and nobody listed yet is starting. */
  readonly turnLive?: boolean
}): ChildState {
  const { view } = input
  if (view) {
    if (view.awaiting?.type === "approval") return "approval"
    if (view.awaiting?.type === "answer") return "answer"
    if (view.awaiting?.type === "resume") return "resume"
    if (view.ended) return "ended"
    if (view.status === "queued") return "starting"
    if (view.status === "running") return input.asking ? "asking" : "working"
    if (view.status === "succeeded") return "done"
    if (view.status === "failed") return "failed"
    return "stopped"
  }

  if (input.spawned?.pending) return "starting"
  switch (input.waited?.status) {
    case "succeeded":
      return "done"
    case "failed":
      return "failed"
    case "cancelled":
      return "stopped"
    case "awaiting_approval":
      return "approval"
    case "awaiting_answer":
      return "answer"
    default:
      return input.turnLive ? "starting" : "unknown"
  }
}

/** The run of a child at work, if any is: its thread's active run. */
export function activeRun(view: AgentChild | undefined): AgentChildRun | undefined {
  return view?.runs.find((run) => run.id === view.activeRunId)
}

/** The time a child spent at work, across its runs, at `now`. Waiting for a decision is not. */
export function workedMs(view: AgentChild, now: number): number {
  return view.runs.reduce((total, run) => {
    if (!run.startedAt) return total
    const start = Date.parse(run.startedAt)
    const end = run.completedAt ? Date.parse(run.completedAt) : now
    return Number.isNaN(start) || Number.isNaN(end) ? total : total + Math.max(0, end - start)
  }, 0)
}

/**
 * A child's name, from the key the Agent spawned it with: "supplier-terms" reads "Supplier terms",
 * "checkINV4490" reads "Check INV4490". The key's own capitals stay.
 */
export function childTitle(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : key
}

/** The question a child at work waits on, from its live parts: its `ask_parent` call in flight. */
export function liveQuestion(parts: readonly NormalizedPart[]): string | null {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part?.kind !== "tool" || part.tool.toolName !== "ask_parent") continue
    if (part.tool.state !== "input-available") return null
    const input = isRecord(part.tool.input) ? part.tool.input : {}
    return typeof input.question === "string" ? input.question.trim() : null
  }
  return null
}

/** How long, in words: "48s", "1m 12s", "1h 5m". */
export function formatWorked(ms: number, messages: AgentMessages["delegation"]): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return messages.seconds(seconds)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return messages.minutes(minutes, seconds % 60)
  return messages.hours(Math.floor(minutes / 60), minutes % 60)
}

/** The children a `wait_agent` call waits for, by key when the parts named them. */
function waitedKeys(tool: NormalizedTool, keys: ReadonlyMap<string, string>): readonly string[] {
  const input = isRecord(tool.input) ? tool.input : {}
  const ids = Array.isArray(input.runIds) ? input.runIds : []
  return ids.flatMap((id) => (typeof id === "string" ? [keys.get(id) ?? ""] : []))
}

/**
 * What a delegation call reads as in the work, while it is made and once it answered: the Agent's
 * spawns and waits, and a sub-agent's question. `null` for any other tool.
 */
export function describeDelegationTool(
  tool: NormalizedTool,
  parts: readonly NormalizedPart[],
  messages: AgentMessages
): { readonly title: string; readonly running: string } | null {
  const labels = messages.delegation
  if (tool.toolName === "spawn_agent") {
    const input = isRecord(tool.input) ? tool.input : {}
    const key = typeof input.key === "string" ? input.key.trim() : ""
    if (tool.state === "output-error") {
      const failed = labels.spawnFailed(childTitle(key))
      return { title: failed, running: failed }
    }
    if (tool.state === "output-available") {
      return {
        title: labels.delegated(childTitle(key)),
        running: labels.delegatingCount(countSpawns(parts)),
      }
    }
    return {
      title: labels.delegating(childTitle(key)),
      running: labels.delegatingCount(countSpawns(parts)),
    }
  }

  if (tool.toolName === "ask_parent") {
    const input = isRecord(tool.input) ? tool.input : {}
    const question = typeof input.question === "string" ? input.question.trim() : ""
    return { title: labels.askedAgent(question), running: labels.states.asking }
  }

  if (tool.toolName === "wait_agent") {
    const keys = new Map<string, string>()
    for (const part of parts) {
      if (part.kind !== "tool") continue
      const child = spawnedChild(part.tool)
      if (child && !child.pending) keys.set(child.id, childTitle(child.key))
    }
    const waitedFor = waitedKeys(tool, keys)
    const named = waitedFor.every(Boolean) ? waitedFor : []
    const waiting =
      named.length === 1
        ? labels.waitingFor(named[0] ?? "")
        : labels.waitingForCount(waitedFor.length)
    if (tool.state === "output-error")
      return { title: labels.waitFailed, running: labels.waitFailed }
    if (tool.state === "output-available") {
      const heard =
        named.length === 1
          ? labels.heardFrom(named[0] ?? "")
          : labels.heardFromCount(waitedFor.length)
      return { title: heard, running: heard }
    }
    return { title: waiting, running: waiting }
  }

  return null
}

function countSpawns(parts: readonly NormalizedPart[]): number {
  return parts.filter((part) => part.kind === "tool" && part.tool.toolName === "spawn_agent").length
}

function modelRef(value: unknown): SpawnedChild["model"] | undefined {
  return isRecord(value) && typeof value.provider === "string" && typeof value.modelId === "string"
    ? { provider: value.provider, modelId: value.modelId }
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
