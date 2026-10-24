import type { AgentApproval, TranscriptApprovals } from "../approvals"
import type { AgentMessages } from "../i18n/en"
import type { LiveRunState } from "../live-run"
import {
  type AgentChild,
  type ChildState,
  childState,
  isActive,
  liveQuestion,
  type SpawnedChild,
  type ThreadDelegation,
  type WaitedChild,
} from "./interpret"

// Where each child of a reply stands for this reader, derived once for its card and its group:
// from the child's own read (`awaiting`, `ended`) first, the reply's parts only without it.

/** Who a call waits on: the reader, someone they can name, or whoever decides. */
export type WaitingOn =
  | { readonly kind: "you" }
  | { readonly kind: "anyone" }
  | { readonly kind: "person"; readonly name: string }

export interface ChildModel {
  readonly child: SpawnedChild
  readonly view?: AgentChild
  /** Its run at work, as its stream shows it. */
  readonly live?: LiveRunState
  readonly state: ChildState
  readonly waited?: WaitedChild
  /** Its calls held under the turn that spawned it: their cards are in its card. */
  readonly approvals: readonly AgentApproval[]
  /** A call it holds under a later turn, which shows its card with that turn. */
  readonly heldLater?: AgentApproval
  /** Who its call waits on. */
  readonly waitingOn: WaitingOn
  /** The reader is the one to act: decide its call, or answer its question. */
  readonly needsReader: boolean
}

export function childModel(input: {
  readonly child: SpawnedChild
  readonly view?: AgentChild
  readonly live?: LiveRunState
  /** The turn that spawned it. */
  readonly runId: string | null
  readonly turnLive: boolean
  readonly observed: boolean
  readonly delegation: ThreadDelegation
  readonly approvals: TranscriptApprovals | null
}): ChildModel {
  const { child, view, live, runId, turnLive, observed, delegation, approvals } = input
  const question = live ? liveQuestion(live.parts) : null
  const waited = waitedFor(delegation.waited, child, view)
  const state = childState({ view, spawned: child, waited, asking: question !== null, turnLive })

  // A call names the run that made it and the turn it is filed on: the spawning turn's sit in the
  // card, a later turn's with that turn, as the transcript places them.
  const runIds = new Set(view?.runs.map((run) => run.id) ?? [child.id])
  const own = (approvals?.approvals ?? []).filter((approval) => runIds.has(approval.callerRunId))
  const here = own.filter((approval) => approval.runId === runId)
  const awaited = new Set(view?.awaiting?.type === "approval" ? view.awaiting.approvalIds : [])
  const waitingFor = own.filter((approval) => awaited.has(approval.id))
  const decides = waitingFor.some((approval) => approvals?.canDecide(approval) ?? false)
  const first = waitingFor[0]
  const heldLater = waitingFor.find((approval) => approval.runId !== runId)
  const waitingOn: WaitingOn = decides
    ? { kind: "you" }
    : first && approvals
      ? { kind: "person", name: approvals.requesterName(first) }
      : { kind: "anyone" }

  return {
    child,
    ...(view ? { view } : {}),
    ...(live ? { live } : {}),
    state,
    ...(waited ? { waited } : {}),
    approvals: here,
    ...(heldLater ? { heldLater } : {}),
    waitingOn,
    needsReader: (state === "approval" && decides) || (state === "answer" && !observed),
  }
}

/** Whether a sub-agent's call shows in its card: held under the turn that spawned it. */
export function heldInCard(approval: AgentApproval, delegation: ThreadDelegation): boolean {
  if (!approval.caller) return false
  const owner = delegation.ownerOf(approval.caller.key, approval.runId)
  return owner !== undefined && delegation.spawnedBy.get(owner) === approval.runId
}

/** Whether a group's children no longer change on their own: none works, waits or will continue. */
export function isSettled(state: ChildState): boolean {
  return (
    state === "done" ||
    state === "failed" ||
    state === "stopped" ||
    state === "ended" ||
    state === "unknown"
  )
}

/** One part of a group's summary: how many stand where, and whether the reader must act. */
export interface SummaryPart {
  readonly text: string
  readonly urgent: boolean
}

/** How a group's children stand, in the order a reader cares: what waits on them first. */
export function groupSummary(
  models: readonly ChildModel[],
  messages: AgentMessages
): SummaryPart[] {
  const labels = messages.delegation
  const count = (test: (model: ChildModel) => boolean) => models.filter(test).length
  const waiting = (model: ChildModel) =>
    (model.state === "approval" || model.state === "answer") && !model.needsReader

  const forYou = count((model) => model.needsReader)
  const others = models.filter(waiting)
  const names = new Set(
    others.map((model) => (model.waitingOn.kind === "person" ? model.waitingOn.name : ""))
  )
  const [name] = names
  const working = count((model) => isActive(model.state))
  const later = count((model) => model.state === "resume")
  const done = count((model) => model.state === "done")
  const failed = count((model) => model.state === "failed")
  const stopped = count((model) => model.state === "stopped" || model.state === "ended")

  return [
    forYou > 0 ? { text: labels.waitingYou(forYou), urgent: true } : null,
    others.length > 0
      ? {
          text:
            names.size === 1 && name
              ? labels.waitingOn(others.length, name)
              : labels.waitingOthers(others.length),
          urgent: false,
        }
      : null,
    working > 0 ? { text: labels.working(working), urgent: false } : null,
    later > 0 ? { text: labels.later(later), urgent: false } : null,
    done > 0 ? { text: labels.done(done), urgent: false } : null,
    failed > 0 ? { text: labels.failed(failed), urgent: false } : null,
    stopped > 0 ? { text: labels.stopped(stopped), urgent: false } : null,
  ].filter((part): part is SummaryPart => part !== null)
}

/** What `wait_agent` last said of any of the child's runs. */
function waitedFor(
  waited: ReadonlyMap<string, WaitedChild>,
  child: SpawnedChild,
  view: AgentChild | undefined
): WaitedChild | undefined {
  const ids = view ? view.runs.map((run) => run.id) : [child.id]
  return ids.reduce<WaitedChild | undefined>((last, id) => waited.get(id) ?? last, undefined)
}
