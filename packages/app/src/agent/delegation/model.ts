import type { AgentApproval, TranscriptApprovals } from "../approvals"
import type { AgentMessages } from "../i18n/en"
import type { LiveRunState } from "../live-run"
import {
  type AgentChild,
  type ChildState,
  childState,
  childTitle,
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

/** One clause of a reply's line: some sub-agents by name, and how they stand. */
export interface LineClause {
  readonly names: string
  readonly verb: string
  /** `urgent`: the reader is the one to act. `live`: still at work. */
  readonly tone: "urgent" | "live" | "quiet"
}

/**
 * A reply's sub-agents as a sentence, its clauses in the order a reader cares about: what waits
 * on them, what is at work, then how the rest ended. "Terms needs your approval · History is
 * working", "Terms, History and Disputes finished".
 */
export function lineClauses(
  models: readonly ChildModel[],
  messages: AgentMessages
): readonly LineClause[] {
  const labels = messages.delegation.line
  const clause = (
    test: (model: ChildModel) => boolean,
    verb: (agents: number) => string,
    tone: LineClause["tone"]
  ): LineClause | null => {
    const named = models.filter(test).map((model) => shortName(childTitle(model.child.key)))
    return named.length > 0 ? { names: labels.names(named), verb: verb(named.length), tone } : null
  }
  const person = personWaitedOn(models)
  const urgent = [
    clause((model) => model.needsReader && model.state === "approval", labels.approval, "urgent"),
    clause((model) => model.needsReader && model.state === "answer", labels.answer, "urgent"),
  ]

  // Many, or long-named, read as a count: names would turn the line into a paragraph. Whoever
  // waits on the reader is still named.
  // A lone agent is always named, its name shortened if it must be.
  if (
    models.length > NAMED_AGENTS ||
    (models.length > 1 && models.some((model) => !named(model)))
  ) {
    const counts = messages.delegation
    const counted = (
      test: (model: ChildModel) => boolean,
      verb: (agents: number) => string,
      tone: LineClause["tone"]
    ): LineClause | null => {
      const agents = models.filter(test).length
      return agents > 0 ? { names: "", verb: verb(agents), tone } : null
    }
    return [
      { names: counts.count(models.length), verb: "", tone: "quiet" as const },
      ...urgent,
      counted(
        waitingOther,
        person ? (agents) => counts.waitingOn(agents, person) : counts.waitingOthers,
        "quiet"
      ),
      counted((model) => isActive(model.state), counts.working, "live"),
      counted((model) => model.state === "resume", counts.later, "quiet"),
      counted((model) => model.state === "done", counts.done, "quiet"),
      counted((model) => model.state === "failed", counts.failed, "quiet"),
      counted(
        (model) => model.state === "stopped" || model.state === "ended",
        counts.stopped,
        "quiet"
      ),
    ].filter((part): part is LineClause => part !== null)
  }

  return [
    ...urgent,
    clause(
      waitingOther,
      person ? (agents) => labels.waitingOn(agents, person) : labels.waiting,
      "quiet"
    ),
    clause((model) => model.state === "asking", labels.asking, "live"),
    clause((model) => model.state === "working", labels.working, "live"),
    clause((model) => model.state === "starting", labels.starting, "live"),
    clause((model) => model.state === "resume", labels.later, "quiet"),
    clause((model) => model.state === "done", labels.done, "quiet"),
    clause((model) => model.state === "failed", labels.failed, "quiet"),
    clause(
      (model) => model.state === "stopped" || model.state === "ended",
      labels.stopped,
      "quiet"
    ),
  ].filter((part): part is LineClause => part !== null)
}

/** Waiting on someone, but not on the reader: their approval or their answer. */
function waitingOther(model: ChildModel): boolean {
  return (model.state === "approval" || model.state === "answer") && !model.needsReader
}

/** The one person the others wait on, when it is one person. */
function personWaitedOn(models: readonly ChildModel[]): string | null {
  const people = new Set(
    models
      .filter(waitingOther)
      .map((model) => (model.waitingOn.kind === "person" ? model.waitingOn.name : ""))
  )
  const [person] = people
  return people.size === 1 && person ? person : null
}

/** The longest a name reads in the line before it is cut at a word; its thread shows it whole. */
const LINE_NAME_LENGTH = 28

/** Up to this many sub-agents, with short names, the line names each; past it, it counts them. */
const NAMED_AGENTS = 3

function named(model: ChildModel): boolean {
  return childTitle(model.child.key).length <= 20
}

function shortName(name: string): string {
  if (name.length <= LINE_NAME_LENGTH) return name
  const cut = name.slice(0, LINE_NAME_LENGTH)
  const word = cut.lastIndexOf(" ")
  return `${(word > LINE_NAME_LENGTH / 2 ? cut.slice(0, word) : cut).replace(/[\s,.:;-]+$/, "")}…`
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
