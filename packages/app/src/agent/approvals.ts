import type { DecideAgentApprovalResponse, ListAgentThreadApprovalsResponse } from "@sixb/client"
import { createContext, useContext } from "react"
import type { NormalizedPart } from "./parts"
import type { AgentMessage, AgentRun } from "./types"

/** A call the agent made that waits, or waited, for its requester's decision. */
export type AgentApproval = ListAgentThreadApprovalsResponse["approvals"][number]

export type AgentApprovalStatus = AgentApproval["status"]

/** What the agent may change without asking, from the strictest. */
export const AGENT_APPROVAL_MODES = ["manual", "accept-edits", "auto"] as const

export type AgentApprovalMode = (typeof AGENT_APPROVAL_MODES)[number]

/**
 * The mode Shift+Tab switches to: between Manual and Accept edits only. Auto is chosen from the menu,
 * never reached by a key pressed in passing; from Auto, the key goes back to Manual.
 */
export function toggledApprovalMode(mode: AgentApprovalMode): AgentApprovalMode {
  return mode === "manual" ? "accept-edits" : "manual"
}

/** From least to most allowed. */
const APPROVAL_MODE_RANK: Readonly<Record<AgentApprovalMode, number>> = {
  manual: 0,
  "accept-edits": 1,
  auto: 2,
}

/** Whether a turn in `mode` runs this call without asking. */
export function approvalModeAllows(mode: AgentApprovalMode, call: AgentApproval["call"]): boolean {
  return APPROVAL_MODE_RANK[mode] >= APPROVAL_MODE_RANK[alwaysAllowMode(call)]
}

/** The mode "Always allow" leaves its requester in: the least that runs such a call. */
export function alwaysAllowMode(call: AgentApproval["call"]): AgentApprovalMode {
  return call.kind === "action" && call.effect === "ontology" ? "accept-edits" : "auto"
}

/** A turn that ended on calls waiting for its requester. It resumes once they decide. */
export function isAwaitingApproval(run: Pick<AgentRun, "status" | "finishReason"> | null): boolean {
  return run?.status === "succeeded" && run.finishReason === "awaiting_approval"
}

/** The call a held command names, as the API answered it: enough to show it before its record. */
export type HeldCall =
  | {
      readonly id: string
      readonly kind: "action"
      readonly actionId: string
      readonly subject?: { readonly objectTypeId: string; readonly primaryId: string }
    }
  | { readonly id: string; readonly kind: "workflow"; readonly workflowId: string }

/**
 * The calls a `bash` output says are waiting for approval. The CLI prints the API's 202 answer as
 * one JSON line and exits 4, but the output is the model's to shape, so every line is read and the
 * exit code is not trusted: only the approval's record says what waits, and a line that names no
 * record shows nothing to act on.
 */
export function heldCallsInOutput(output: unknown): HeldCall[] {
  if (!isRecord(output) || typeof output.stdout !== "string") return []

  return output.stdout.split("\n").flatMap((line): HeldCall[] => {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) return []

    const parsed = parseJson(trimmed)
    if (!isRecord(parsed) || parsed.status !== "awaiting_approval") return []

    const held = heldCall(parsed.approval)
    return held ? [held] : []
  })
}

/** The held calls of an assistant message's tools, in the order they were made. */
export function heldCallsInParts(parts: readonly NormalizedPart[]): HeldCall[] {
  const seen = new Set<string>()

  return parts.flatMap((part) => {
    if (part.kind !== "tool" || part.tool.toolName !== "bash") return []
    if (part.tool.state !== "output-available") return []

    return heldCallsInOutput(part.tool.output).filter((call) => {
      if (seen.has(call.id)) return false
      seen.add(call.id)
      return true
    })
  })
}

/** The ids of the held calls the transcript's messages already show a card for. */
export function heldCallIdsInMessages(messages: readonly AgentMessage[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.role !== "assistant") continue

    for (const part of message.parts) {
      if (part.type !== "tool-call" || part.toolName !== "bash") continue
      if (part.state !== "output-available") continue

      for (const call of heldCallsInOutput(part.output)) ids.add(call.id)
    }
  }
  return ids
}

/**
 * A user message Sixb wrote to resume a turn: it carries only how the held calls ended, which the
 * transcript shows on their cards.
 */
export function isApprovalOutcomeMessage(message: AgentMessage): boolean {
  return (
    message.role === "user" &&
    message.parts.length > 0 &&
    message.parts.every((part) => part.type === "approval-outcome")
  )
}

/** A held call as its card names it, from its record. */
export function heldCallOf(approval: AgentApproval): HeldCall {
  const call = approval.call
  if (call.kind === "workflow") {
    return { id: approval.id, kind: "workflow", workflowId: call.workflowId }
  }

  return {
    id: approval.id,
    kind: "action",
    actionId: call.actionId,
    ...(call.subject.kind === "object"
      ? { subject: { objectTypeId: call.subject.objectTypeId, primaryId: call.subject.primaryId } }
      : {}),
  }
}

/** How a call the transcript holds no record of ended, from the message that told the agent. */
export interface ReportedApprovalOutcome {
  readonly status: Exclude<AgentApprovalStatus, "pending">
  readonly outcome?: AgentApproval["outcome"]
  /** The sub-agent that made it, when the turn did not. */
  readonly caller?: AgentApproval["caller"]
}

/**
 * How each held call ended, as the messages that resumed or followed its turn told the agent. A
 * reader without the thread's approvals, such as an observer, still sees each card's outcome.
 */
export function reportedApprovalOutcomes(
  messages: readonly AgentMessage[]
): ReadonlyMap<string, ReportedApprovalOutcome> {
  const outcomes = new Map<string, ReportedApprovalOutcome>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "approval-outcome") continue
      outcomes.set(part.approvalId, {
        status: part.status,
        ...(part.outcome === undefined
          ? {}
          : { outcome: part.outcome as AgentApproval["outcome"] }),
        ...(part.caller === undefined ? {} : { caller: part.caller }),
      })
    }
  }
  return outcomes
}

/** What a decision sends: approve, optionally for good in this thread, or deny. */
export interface AgentApprovalDecision {
  readonly decision: "approve" | "deny"
  readonly always?: true
}

/** A decision that went through. `resume` says why the turn did not continue, when it did not. */
export type AgentApprovalDecided = Pick<DecideAgentApprovalResponse, "approval" | "resume">

/** Why a decision did not go through, as the card tells it. */
export type AgentApprovalDecisionFailure =
  | "expired"
  /** Someone, on another device, decided first. */
  | "decided"
  | "failed"

/** A decision that did not go through; nothing ran. */
export class AgentApprovalDecisionError extends Error {
  readonly name = "AgentApprovalDecisionError"

  constructor(readonly code: AgentApprovalDecisionFailure) {
    super(`[SixbApp] The approval decision did not go through: ${code}.`)
  }
}

/** The held calls of a conversation, as its transcript shows and answers them. */
export interface TranscriptApprovals {
  /** The thread's held calls, oldest first. */
  readonly approvals: readonly AgentApproval[]
  /** False until the first read: a card shows what its command said meanwhile. */
  readonly loaded: boolean
  /** Whether the reader decides on this one: only whoever asked for its turn does. */
  readonly canDecide: (approval: AgentApproval) => boolean
  /** Who decides on it, by name, for the others. */
  readonly requesterName: (approval: AgentApproval) => string
  /**
   * Whether the reader may stop the turn paused on this call: its requester, or the thread's owner.
   * Stopping sets all of the turn's waiting calls aside, and the turn does not resume.
   */
  readonly canStop?: (approval: AgentApproval) => boolean
  /** Stop the paused turn; rejects when it could not. */
  readonly stop?: (approval: AgentApproval) => Promise<void>
  /** Rejects with an {@link AgentApprovalDecisionError} when nothing was decided. */
  readonly decide?: (
    approval: AgentApproval,
    decision: AgentApprovalDecision
  ) => Promise<AgentApprovalDecided>
}

/** What the cards of a transcript read: its approvals when it has them, and the reported outcomes. */
export interface ApprovalCardsContext {
  readonly approvals: TranscriptApprovals | null
  readonly outcomes: ReadonlyMap<string, ReportedApprovalOutcome>
}

export const ApprovalCardsContext = createContext<ApprovalCardsContext>({
  approvals: null,
  outcomes: new Map(),
})

export function useApprovalCards(): ApprovalCardsContext {
  return useContext(ApprovalCardsContext)
}

function heldCall(value: unknown): HeldCall | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return null

  if (value.kind === "workflow" && typeof value.workflowId === "string") {
    return { id: value.id, kind: "workflow", workflowId: value.workflowId }
  }
  if (value.kind !== "action" || typeof value.actionId !== "string") return null

  const subject = value.subject
  return {
    id: value.id,
    kind: "action",
    actionId: value.actionId,
    ...(isRecord(subject) &&
    subject.kind === "object" &&
    typeof subject.objectTypeId === "string" &&
    typeof subject.primaryId === "string"
      ? { subject: { objectTypeId: subject.objectTypeId, primaryId: subject.primaryId } }
      : {}),
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
