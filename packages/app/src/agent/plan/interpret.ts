import type { AgentApproval } from "../approvals"
import type { AgentConversationMessage, AgentConversationTurn } from "../conversation"

// The Agent keeps its plan with `todo`, and keeps nothing else: each call sends the whole list, so
// the newest call is the plan. The chat reads it from the calls, the way the background commands
// are read: one line above the composer while a turn works or waits for an approval, and a row in
// the work for each call.

export type PlanItemStatus = "pending" | "in_progress" | "completed"

export interface PlanItem {
  readonly content: string
  readonly status: PlanItemStatus
}

export interface Plan {
  readonly items: readonly PlanItem[]
  readonly completed: number
  /** What the Agent does now: the first item in progress, or null between two items. */
  readonly current: string | null
  /** Some item is still to do or in progress. */
  readonly unfinished: boolean
}

/** A call to `todo` as the chat holds it, saved or streaming. */
interface PlanCall {
  readonly toolName: string
  readonly state: string
  readonly input?: unknown
  readonly output?: unknown
}

/**
 * A `todo` call that keeps the plan: its input sends a list, and its output counts it. Earlier
 * threads may hold a project's own tool of that name, which reads as any other tool.
 */
export function isPlanCall(call: Pick<PlanCall, "state" | "input" | "output">): boolean {
  // The list is still being written: nothing to tell yet.
  if (call.state === "input-streaming") return true
  if (!isRecord(call.input) || !Array.isArray(call.input.todos)) return false
  if (call.state !== "output-available") return true

  const output = call.output
  return (
    isRecord(output) &&
    typeof output.total === "number" &&
    typeof output.completed === "number" &&
    Array.isArray(output.inProgress)
  )
}

/**
 * The items of a `todo` call's input. The tool checked them before it ran; a call that streams or
 * an earlier thread's may not hold the same, so each item is read on its own: its words trimmed,
 * one without words left out, and a status the chat does not know read as still to do.
 */
export function planItems(input: unknown): readonly PlanItem[] {
  if (!isRecord(input) || !Array.isArray(input.todos)) return []

  return input.todos.flatMap((entry): PlanItem[] => {
    if (!isRecord(entry) || typeof entry.content !== "string") return []

    const content = entry.content.trim()
    if (!content) return []

    const status =
      entry.status === "in_progress" || entry.status === "completed" ? entry.status : "pending"
    return [{ content, status }]
  })
}

/** The plan a `todo` call sends, or null for one that clears it. */
export function planOf(input: unknown): Plan | null {
  const items = planItems(input)
  if (items.length === 0) return null

  return {
    items,
    completed: items.filter((item) => item.status === "completed").length,
    current: items.find((item) => item.status === "in_progress")?.content ?? null,
    unfinished: items.some((item) => item.status !== "completed"),
  }
}

/**
 * The newest plan among calls, oldest first: undefined when none sends one, null when the newest
 * clears it. A call still streaming its list is not one yet, and a refused one changed nothing.
 */
function newestPlan(calls: readonly PlanCall[]): Plan | null | undefined {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]
    if (call?.toolName !== "todo" || !isPlanCall(call)) continue
    if (call.state !== "input-available" && call.state !== "output-available") continue
    return planOf(call.input)
  }
  return undefined
}

/**
 * The plan of the work in progress, while a turn answers or waits for a decision on a call it
 * held: the plan the turn made, else the one it goes on with. A turn goes on with an unfinished
 * plan only when it resumes the replies before it with nothing the user wrote in between, as after
 * an approval or a Continue. Whatever the user writes leaves the plan behind, an answer to the
 * Agent's question too: it reads as any other message, so the Agent sends its plan again when it
 * goes on. Null when the turn has none, and once it ended: done, failed, stopped, or on a question.
 */
export function livePlan(
  messages: readonly Pick<AgentConversationMessage, "role" | "runId" | "parts">[],
  turn: Pick<AgentConversationTurn, "kind">,
  approvals: readonly Pick<AgentApproval, "status" | "runId">[] = []
): Plan | null {
  if (turn.kind !== "responding" && !awaitsApproval(messages.at(-1), turn, approvals)) return null

  // From the newest message back to the user's last one.
  const newest = messages.length - 1
  for (let index = newest; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    if (message.role === "user") return null

    const plan = newestPlan(message.parts.flatMap((part) => (part.type === "tool" ? [part] : [])))
    if (plan === undefined) continue
    if (plan === null) return null

    // The reply at work keeps its plan to the end; one it resumes, only while work is left.
    return index === newest || plan.unfinished ? plan : null
  }

  return null
}

/**
 * The turn paused on calls it held: it is not over, as it resumes once someone decides, there.
 * Stopping it sets the calls aside, and a turn that ends otherwise holds none.
 */
function awaitsApproval(
  newest: Pick<AgentConversationMessage, "role" | "runId"> | undefined,
  turn: Pick<AgentConversationTurn, "kind">,
  approvals: readonly Pick<AgentApproval, "status" | "runId">[]
): boolean {
  return (
    turn.kind === "idle" &&
    newest?.role === "assistant" &&
    approvals.some((approval) => approval.status === "pending" && approval.runId === newest.runId)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
