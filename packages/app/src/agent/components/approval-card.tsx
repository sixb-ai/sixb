import { getActionOptions, getObjectTypeOptions, getWorkflowOptions } from "@sixb/client/hooks"
import { Button, Spinner } from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleOff,
  CirclePause,
  CircleSlash,
  Clock3,
  Database,
  Globe,
  type LucideIcon,
  RefreshCw,
  SkipForward,
  Workflow,
} from "lucide-react"
import { Fragment, useId, useMemo, useRef, useState } from "react"
import { humanizeIdentifier } from "../../pages/console/ontology/lib/labels"
import { ObjectRefLinksContext, useValueTypes, ValueTree, valueSchema } from "../../pages/values"
import {
  type AgentApproval,
  type AgentApprovalDecision,
  AgentApprovalDecisionError,
  type AgentApprovalDecisionFailure,
  alwaysAllowMode,
  approvalModeAllows,
  type HeldCall,
  useApprovalCards,
} from "../approvals"
import { capitalize, humanize } from "../bash/interpret"
import { useDelegationCards } from "../delegation/context"
import { childTitle } from "../delegation/interpret"
import { formatRelativeTime } from "../format"
import { useAgentMessages } from "../i18n"
import type { AgentMessages } from "../i18n/en"
import { objectContextTitleQuery } from "../object-context-title"
import { samePrincipal } from "../sharing"
import { ACTIVITY_STATUS_ROW_CLASS_NAME } from "./activity-status"

const DAY_MS = 24 * 60 * 60 * 1_000

/** The cards of the calls a turn held, one under the other. */
export function ApprovalCards({ calls }: { readonly calls: readonly HeldCall[] }) {
  if (calls.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      {calls.map((call) => (
        <ApprovalCard key={call.id} held={call} />
      ))}
    </div>
  )
}

/** The call as the card names it, from its record or else from what the command answered. */
type CardCall =
  | {
      readonly kind: "action"
      readonly actionId: string
      readonly subject?: { readonly objectTypeId: string; readonly primaryId: string }
      readonly params?: Readonly<Record<string, unknown>>
      readonly effect?: "ontology" | "external"
    }
  | {
      readonly kind: "workflow"
      readonly workflowId: string
      readonly input?: Readonly<Record<string, unknown>>
    }

/**
 * What the card says about the call. `unknown` is a held call whose record is still loading; `asked`
 * one in a transcript read without records whose outcome no message reported yet (an observer's);
 * `lost` an approved call that could not run because the sign-in behind it ended.
 */
type CardState =
  | "pending"
  | "running"
  | "ran"
  | "failed"
  | "lost"
  | "denied"
  | "superseded"
  | "cancelled"
  | "expired"
  | "unknown"
  | "asked"

/** What the card adds once a decision went through: the mode it raised, or why the turn waits. */
type DecisionNotice = { readonly tone: "info" | "warning"; readonly text: string }

/**
 * One call the agent made that waits for, or waited for, its requester: what it does, to which
 * record, with which values, and whether it stays in the project's data. Whoever asked for the turn
 * approves or denies it here; everyone else reads it, and who decides. A call the thread holds no
 * record of shows only when a message reported how it ended.
 */
export function ApprovalCard({
  held,
  underCaller = false,
}: {
  readonly held: HeldCall
  /** Right under the line of the sub-agent that asked, which names it already. */
  readonly underCaller?: boolean
}) {
  const messages = useAgentMessages()
  const labels = messages.approvals
  const locale = useLocale()
  const alsoId = useId()
  const sectionRef = useRef<HTMLElement>(null)
  // The buttons go once a decision lands: the reader's place moves to what now says how it ended.
  const focusStatus = () =>
    requestAnimationFrame(() =>
      sectionRef.current?.querySelector<HTMLElement>("[data-approval-focus]")?.focus()
    )
  const { approvals: context, outcomes } = useApprovalCards()
  const delegationCards = useDelegationCards()
  const approval = context?.approvals.find((candidate) => candidate.id === held.id) ?? null
  const reported = approval ? undefined : outcomes.get(held.id)
  const call = cardCall(held, approval)
  const state: CardState = approval
    ? stateOf(approval.status, approval.outcome)
    : reported
      ? stateOf(reported.status, reported.outcome)
      : context
        ? "unknown"
        : "asked"

  const [deciding, setDeciding] = useState<"approve" | "always" | "deny" | null>(null)
  const [failure, setFailure] = useState<AgentApprovalDecisionFailure | null>(null)
  const [notice, setNotice] = useState<DecisionNotice | null>(null)
  const [showInput, setShowInput] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopFailed, setStopFailed] = useState(false)

  const definition = useCallDefinition(call)
  const title = definition.name
  const effect = effectOf(call, definition, messages)
  // A sub-agent's call says which one asked; its own card comes with the sub-agent's.
  const caller = underCaller ? undefined : (approval?.caller ?? reported?.caller)

  const canDecide =
    state === "pending" && approval !== null && context?.decide !== undefined
      ? context.canDecide(approval)
      : false
  const requester = approval && context ? context.requesterName(approval) : null
  // Stopping applies to the whole paused turn: its first waiting card offers it. A turn still at
  // work is not paused, even when one of its sub-agents waits: stopping it there would end it.
  const turnAtWork = approval !== null && delegationCards?.liveRunId === approval.runId
  const canStop =
    !turnAtWork &&
    state === "pending" &&
    approval !== null &&
    context?.stop !== undefined &&
    (context.canStop?.(approval) ?? false) &&
    context.approvals.find((other) => other.runId === approval.runId && other.status === "pending")
      ?.id === approval.id
  // A waiting call shows what it runs with; a decided one keeps it a click away.
  const waiting = state === "pending" || state === "unknown"
  const expiredDays = approval
    ? Math.round((Date.parse(approval.expiresAt) - Date.parse(approval.createdAt)) / DAY_MS)
    : 7

  // "Always allow" raises the requester's mode here, and approves the turn's other waiting calls
  // that mode runs: the button says both before anyone presses it.
  const alwaysMode = approval ? alwaysAllowMode(approval.call) : null
  const alwaysModeLabel = alwaysMode ? messages.approvalModes.modes[alwaysMode].label : ""
  const alsoApproved =
    approval && alwaysMode
      ? (context?.approvals ?? []).filter(
          (other) =>
            other.id !== approval.id &&
            other.runId === approval.runId &&
            other.status === "pending" &&
            samePrincipal(other.requestedBy, approval.requestedBy) &&
            approvalModeAllows(alwaysMode, other.call)
        ).length
      : 0

  // A reported outcome with no record is only read here: and with no record, the card is dropped
  // once the list says the thread holds none.
  if (!approval && !reported && context?.loaded) return null

  const stopWaiting = () => {
    if (!approval || !context?.stop || stopping) return
    setStopping(true)
    setStopFailed(false)
    context
      .stop(approval)
      .catch(() => setStopFailed(true))
      .finally(() => {
        setStopping(false)
        focusStatus()
      })
  }

  const decide = (choice: "approve" | "always" | "deny") => {
    if (!approval || !context?.decide || deciding) return
    const decision: AgentApprovalDecision =
      choice === "deny"
        ? { decision: "deny" }
        : choice === "always"
          ? { decision: "approve", always: true }
          : { decision: "approve" }

    setDeciding(choice)
    setFailure(null)
    setNotice(null)
    context
      .decide(approval, decision)
      .then((decided) => {
        const resume = decided.resume
        if (resume) {
          setNotice({
            tone: "warning",
            text: resume.retrying ? labels.resume.retrying : labels.resume.refused,
          })
        } else if (choice === "always") {
          setNotice({ tone: "info", text: labels.modeRaised(alwaysModeLabel) })
        }
      })
      .catch((error: unknown) =>
        setFailure(error instanceof AgentApprovalDecisionError ? error.code : "failed")
      )
      .finally(() => {
        setDeciding(null)
        focusStatus()
      })
  }

  const subjectLine =
    (call.kind === "action" && call.subject) || caller ? (
      <>
        {call.kind === "action" && call.subject ? <Subject subject={call.subject} /> : null}
        {call.kind === "action" && call.subject && caller ? (
          <span aria-hidden="true">·</span>
        ) : null}
        {caller ? (
          <span className="truncate">{labels.fromSubagent(childTitle(caller.key))}</span>
        ) : null}
      </>
    ) : null

  const notes = (
    <>
      {notice ? (
        <p
          role="status"
          className={cn(
            "text-xs",
            notice.tone === "warning" ? "text-amber-700 dark:text-amber-400" : "text-foreground"
          )}
        >
          {notice.text}
        </p>
      ) : null}
      {stopFailed ? (
        <p role="alert" className="text-xs text-destructive">
          {labels.stopFailed}
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="text-xs text-destructive">
          {labels.failures[failure]}
        </p>
      ) : null}
    </>
  )

  // Decided, the call is a line of the reply's record, as its work is: how it ended, what it was
  // and to what, its values a click away.
  if (!waiting) {
    const when = approval?.decidedAt
    const detail = outcomeDetail(state, approval?.outcome ?? reported?.outcome, expiredDays, labels)
    const line = (
      <>
        <StatusLine state={state} requester={requester} messages={messages} inline />
        <span className="text-muted-foreground/60" aria-hidden="true">
          ·
        </span>
        <span className="min-w-0 truncate">
          <span className="font-medium text-foreground/85">{title}</span>
          {subjectLine ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span className="ml-1.5 text-muted-foreground/60" aria-hidden="true">
                ·
              </span>
              {subjectLine}
            </span>
          ) : null}
        </span>
        {when ? (
          <span className="shrink-0 text-muted-foreground/70 tabular-nums">
            <span className="text-muted-foreground/60" aria-hidden="true">
              ·{" "}
            </span>
            {formatRelativeTime(when, locale, messages.time)}
          </span>
        ) : null}
      </>
    )
    return (
      <section
        ref={sectionRef}
        aria-label={labels.card(title)}
        data-approval-state={state}
        data-approval-id={held.id}
        tabIndex={-1}
        className="flex min-w-0 flex-col gap-1 outline-none"
      >
        {approval ? (
          <button
            data-approval-focus=""
            type="button"
            aria-expanded={showInput}
            onClick={() => setShowInput((value) => !value)}
            className={cn(
              ACTIVITY_STATUS_ROW_CLASS_NAME,
              "outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            )}
          >
            {line}
            <ChevronRight
              className="size-3.5 shrink-0 opacity-50 transition-[opacity,transform] group-hover:opacity-100 group-aria-expanded:rotate-90"
              aria-hidden="true"
            />
          </button>
        ) : (
          // Read without its record, there is nothing more to open.
          <p data-approval-focus="" tabIndex={-1} className={ACTIVITY_STATUS_ROW_CLASS_NAME}>
            {line}
          </p>
        )}
        {detail ? <p className="pl-6 text-xs text-muted-foreground">{detail}</p> : null}
        {showInput && approval ? (
          <div className="pt-1 pb-1 pl-5">
            <CallInput call={call} definition={definition} emptyLabel={labels.noInput} />
            {effect ? (
              <p className="mt-2 text-xs">
                <EffectLine effect={effect} />
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="pl-5 empty:hidden">{notes}</div>
      </section>
    )
  }

  // Waiting, it is the one thing in the reply to act on: what, to what, with which values, what it
  // reaches, then the decision.
  return (
    <section
      ref={sectionRef}
      aria-label={labels.card(title)}
      aria-busy={deciding !== null}
      data-approval-state={state}
      data-approval-id={held.id}
      // A sub-agent's line brings the reader here when the call waits under a later turn.
      tabIndex={-1}
      className="min-w-0 rounded-2xl bg-card p-4 text-card-foreground shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_1px_2px_rgb(0_0_0/0.03),0_4px_16px_rgb(0_0_0/0.035)] outline-none sm:p-5 dark:shadow-[0_0_0_1px_rgb(255_255_255/0.09)]"
    >
      {/* The reader's own to decide: its buttons say so, and the status is for screen readers. For
          anyone else, it says who decides. Under a sub-agent's line, the line says it already. */}
      {underCaller ? null : canDecide ? (
        <p data-approval-focus="" tabIndex={-1} role="status" className="sr-only">
          {labels.waitingYou}
        </p>
      ) : (
        <div className="mb-2">
          <StatusLine state={state} requester={requester} messages={messages} />
        </div>
      )}

      <div className="flex min-w-0 items-start gap-3">
        <h3 className="flex min-w-0 flex-1 items-center gap-2 text-[15px] leading-snug font-semibold tracking-[-0.01em] text-foreground">
          {canDecide && !underCaller ? (
            <span className="size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
          ) : null}
          <span className="min-w-0">{title}</span>
        </h3>
        {canStop ? (
          <button
            type="button"
            onClick={stopWaiting}
            disabled={stopping || deciding !== null}
            title={labels.stopWaitingHint}
            className="-my-0.5 -mr-2 shrink-0 rounded-full px-2 py-1 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
          >
            {stopping ? labels.stoppingWaiting : labels.stopWaiting}
          </button>
        ) : null}
      </div>
      {/* To what; and when it only changes records here, that reassurance, quietly beside it. */}
      <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-muted-foreground">
        {subjectLine}
        {effect?.reach === "records" ? <EffectLine effect={effect} /> : null}
      </p>

      <div className="mt-3">
        <CallInput call={call} definition={definition} emptyLabel={labels.noInput} />
      </div>

      {/* Reaching past the app is the last thing read before saying yes. */}
      {effect?.reach === "outside" ? (
        <p className="mt-3.5 border-t border-border/60 pt-3 text-[13px]">
          <EffectLine effect={effect} />
        </p>
      ) : null}

      {canDecide ? (
        <div className={effect?.reach === "outside" ? "mt-3" : "mt-4"}>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={deciding !== null}
              onClick={() => decide("deny")}
              className="h-8 rounded-full px-4 shadow-none"
            >
              {deciding === "deny" ? <Spinner className="size-3.5" /> : null}
              {deciding === "deny" ? labels.denying : labels.deny}
            </Button>
            <span className="flex-1" />
            {/* Both ways to say yes, side by side: this once, or from now on in this conversation. */}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={deciding !== null}
              onClick={() => decide("always")}
              title={labels.alwaysAllowHint(alwaysModeLabel)}
              aria-describedby={alsoApproved > 0 ? alsoId : undefined}
              className="h-8 rounded-full px-4 shadow-none"
            >
              {deciding === "always" ? <Spinner className="size-3.5" /> : null}
              {/* For a call that reaches outside, it lets every such call run from now on. */}
              {alwaysMode === "auto" ? labels.alwaysAllowAll : labels.alwaysAllow}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={deciding !== null}
              onClick={() => decide("approve")}
              className="h-8 rounded-full px-4 shadow-none"
            >
              {deciding === "approve" ? <Spinner className="size-3.5" /> : null}
              {deciding === "approve" ? labels.approving : labels.approve}
            </Button>
          </div>
          {alsoApproved > 0 ? (
            <p id={alsoId} className="mt-2 text-xs text-muted-foreground">
              {labels.alwaysAllowAlso(alsoApproved)}
            </p>
          ) : null}
        </div>
      ) : state === "pending" && requester !== null ? (
        <p className="mt-3 text-xs text-muted-foreground">{labels.onlyRequester(requester)}</p>
      ) : null}

      <div className="mt-3 flex flex-col gap-1 empty:hidden">{notes}</div>
    </section>
  )
}

/** Where the call stands, for anyone but the one who decides it: their buttons say it already. */
function StatusLine({
  state,
  requester,
  messages,
  inline = false,
}: {
  readonly state: CardState
  readonly requester: string | null
  readonly messages: AgentMessages
  /** In a decided call's line: its icon in the tone, its words in the line's. */
  readonly inline?: boolean
}) {
  const { Icon, label, tone } = statusOf(state, requester, messages)
  const toneClass = cn(
    tone === "waiting" && "text-amber-700 dark:text-amber-400",
    tone === "done" && "text-emerald-600 dark:text-emerald-400",
    tone === "error" && "text-destructive",
    tone === "muted" && "text-muted-foreground"
  )
  const icon =
    state === "running" ? (
      <Spinner className="size-3 shrink-0" />
    ) : tone === "waiting" ? (
      <span className="relative flex size-2 shrink-0" aria-hidden="true">
        <span className="absolute inset-0 rounded-full bg-amber-500/40 motion-safe:animate-ping dark:bg-amber-400/40" />
        <span className="relative size-2 rounded-full bg-amber-500 dark:bg-amber-400" />
      </span>
    ) : (
      <Icon className={cn("size-3.5 shrink-0", inline && toneClass)} aria-hidden="true" />
    )

  if (inline) {
    return (
      <span className="flex shrink-0 items-center gap-1.5">
        {icon}
        <span className={cn(tone === "error" && "text-destructive")}>{label}</span>
      </span>
    )
  }

  return (
    <p
      data-approval-focus=""
      tabIndex={-1}
      role="status"
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-sm text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        toneClass
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </p>
  )
}

function statusOf(
  state: CardState,
  requester: string | null,
  messages: AgentMessages
): {
  readonly Icon: LucideIcon
  readonly label: string
  readonly tone: "waiting" | "done" | "error" | "muted"
} {
  const labels = messages.approvals
  switch (state) {
    case "pending":
      return {
        Icon: CirclePause,
        label: requester === null ? labels.waitingYou : labels.waitingOther(requester),
        tone: "waiting",
      }
    case "unknown":
      return { Icon: CirclePause, label: messages.bash.heldForApproval, tone: "waiting" }
    case "running":
      return { Icon: CircleCheck, label: `${labels.approved} · ${labels.running}`, tone: "done" }
    case "ran":
      return { Icon: CircleCheck, label: labels.approved, tone: "done" }
    case "failed":
      return { Icon: CircleAlert, label: labels.failed, tone: "error" }
    case "lost":
      return { Icon: CircleAlert, label: labels.notRun, tone: "error" }
    case "denied":
      return { Icon: CircleSlash, label: labels.denied, tone: "muted" }
    case "superseded":
      return { Icon: SkipForward, label: labels.superseded, tone: "muted" }
    case "cancelled":
      return { Icon: CircleOff, label: labels.cancelled, tone: "muted" }
    case "expired":
      return { Icon: Clock3, label: labels.expired, tone: "muted" }
    case "asked":
      return { Icon: CirclePause, label: labels.askedForApproval, tone: "muted" }
  }
}

/**
 * The record the action acts on: its type and its title. Named, not linked: the card is read by
 * everyone in the conversation, and the record's page is not theirs to be sent to.
 */
function Subject({
  subject,
}: {
  readonly subject: { readonly objectTypeId: string; readonly primaryId: string }
}) {
  const queryClient = useQueryClient()
  const objectType = useQuery({
    ...getObjectTypeOptions({ path: { objectTypeId: subject.objectTypeId } }),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  const title = useQuery(objectContextTitleQuery(queryClient, subject)).data ?? null
  const typeName = objectType.data?.name ?? humanizeIdentifier(subject.objectTypeId)

  return (
    <span className="min-w-0 truncate">
      {typeName} <span className="text-foreground">{title ?? subject.primaryId}</span>
    </span>
  )
}

/**
 * The values the call runs with, one per line, labelled and formatted as the action or workflow
 * declares them: a date reads as a date, an object reference by its title. Not as a link: the
 * card is read by everyone in the conversation, and the record's page is not theirs to visit.
 */
function CallInput({
  call,
  definition,
  emptyLabel,
}: {
  readonly call: CardCall
  readonly definition: CallDefinition
  readonly emptyLabel: string
}) {
  const value = call.kind === "action" ? call.params : call.input
  const valueTypes = useValueTypes(definition.schemas)

  if (value === undefined) {
    return (
      <div className="space-y-2" aria-hidden="true">
        <div className="h-3.5 w-2/3 rounded bg-muted motion-safe:animate-pulse" />
        <div className="h-3.5 w-1/2 rounded bg-muted motion-safe:animate-pulse" />
      </div>
    )
  }

  const entries = Object.entries(value)
  if (entries.length === 0) {
    return <p className="text-[13px] text-muted-foreground">{emptyLabel}</p>
  }

  return (
    <ObjectRefLinksContext.Provider value={false}>
      <dl className="grid grid-cols-[minmax(4.5rem,max-content)_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-[13px] leading-5">
        {entries.map(([key, item]) => {
          const field = definition.fields?.[key]
          return (
            <Fragment key={key}>
              <dt className="min-w-0 break-words text-muted-foreground">
                {definition.labels?.[key] ?? sentence(key)}
              </dt>
              <dd className="min-w-0 text-foreground">
                {isEnumSchema(fieldSchemaOf(field)) && typeof item === "string" ? (
                  // A declared choice, shown as the code it is rather than as prose.
                  <span className="uppercase">{item}</span>
                ) : (
                  <ValueTree
                    value={item}
                    schema={
                      definition.fields && field !== undefined
                        ? valueSchema(fieldSchemaOf(field), valueTypes)
                        : undefined
                    }
                  />
                )}
              </dd>
            </Fragment>
          )
        })}
      </dl>
    </ObjectRefLinksContext.Provider>
  )
}

function isEnumSchema(schema: unknown): boolean {
  return typeof schema === "object" && schema !== null && Reflect.get(schema, "type") === "enum"
}

/** A declared field: a bare schema, or a field config carrying one. */
function fieldSchemaOf(field: unknown): unknown {
  return typeof field === "object" && field !== null && "schema" in field
    ? (field as { readonly schema: unknown }).schema
    : field
}

interface CallEffect {
  readonly Icon: LucideIcon
  readonly text: string
  /** `outside`: it reaches past the app, which is worth a second look before saying yes. */
  readonly reach: "records" | "outside"
}

/**
 * What saying yes does beyond the values: only changes records in this app, or reaches past it —
 * writing back to the system a record comes from, or acting outside (sending, paying, calling).
 * The framework knows which kind, not which system, nor whether it can be undone.
 */
function effectOf(
  call: CardCall,
  definition: CallDefinition,
  messages: AgentMessages
): CallEffect | null {
  const effects = messages.approvals.effects
  if (call.kind === "workflow") {
    return { Icon: Workflow, text: effects.workflow(sentence(call.workflowId)), reach: "outside" }
  }
  const effect = call.effect ?? (definition.external ? "external" : undefined)
  if (effect === undefined) return null
  if (effect === "ontology") return { Icon: Database, text: effects.ontology, reach: "records" }
  // A write-back alone updates the record's own system; anything else acts outside the app.
  return definition.writeback && !definition.effects
    ? { Icon: RefreshCw, text: effects.writeback, reach: "outside" }
    : { Icon: Globe, text: effects.external, reach: "outside" }
}

function EffectLine({ effect }: { readonly effect: CallEffect }) {
  const { Icon, text, reach } = effect
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        reach === "outside" ? "text-foreground" : "text-muted-foreground"
      )}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      {text}
    </span>
  )
}

/** Why a decided call ended as it did, when its status alone does not say. */
function outcomeDetail(
  state: CardState,
  outcome: AgentApproval["outcome"],
  expiredDays: number,
  labels: AgentMessages["approvals"]
): string | null {
  switch (state) {
    case "superseded":
      return labels.supersededDetail
    case "cancelled":
      return labels.cancelledDetail
    case "expired":
      return labels.expiredDetail(expiredDays)
    case "lost":
      return labels.authorityLost
    case "failed":
      return failureMessage(outcome)
    default:
      return null
  }
}

/** An id as the card names it: "payInvoice" reads "Pay invoice". */
function sentence(id: string): string {
  return capitalize(humanize(id)) || id
}

function failureMessage(outcome: AgentApproval["outcome"]): string | null {
  if (outcome?.kind === "action-run") return outcome.error?.message ?? null
  if (outcome?.kind === "error") return outcome.error.message
  return null
}

interface CallDefinition {
  /** What the card is titled: the action's name, or the workflow's id in words. */
  readonly name: string
  /** The declared schema of each param or input, by id. */
  readonly fields?: Readonly<Record<string, unknown>>
  readonly labels?: Readonly<Record<string, string>>
  /** Schemas whose value types the values may use. */
  readonly schemas: readonly unknown[]
  /** From the definition, until the record says it: a writeback or effects reach out. */
  readonly external?: boolean
  /** It writes back to the system its records come from. */
  readonly writeback?: boolean
  /** It acts outside the app: sends, pays, calls. */
  readonly effects?: boolean
}

const NO_SCHEMAS: readonly unknown[] = []

/** The call's definition as the reader can read it; its id in words until then, or without it. */
function useCallDefinition(call: CardCall): CallDefinition {
  const action = useQuery({
    ...getActionOptions({ path: { actionId: call.kind === "action" ? call.actionId : "" } }),
    enabled: call.kind === "action",
    staleTime: 5 * 60_000,
    retry: false,
  }).data
  const workflow = useQuery({
    ...getWorkflowOptions({
      path: { workflowId: call.kind === "workflow" ? call.workflowId : "" },
    }),
    enabled: call.kind === "workflow",
    staleTime: 5 * 60_000,
    retry: false,
  }).data

  const callId = call.kind === "action" ? call.actionId : call.workflowId

  // Keyed on the call's id, not the call: the card rebuilds the call on every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the id stands for the call
  return useMemo((): CallDefinition => {
    if (call.kind === "workflow") {
      return {
        name: sentence(call.workflowId),
        ...(workflow ? { fields: workflow.input } : {}),
        schemas: NO_SCHEMAS,
      }
    }
    if (!action) return { name: sentence(call.actionId), schemas: NO_SCHEMAS }

    return {
      name: sentence(action.name || action.id),
      fields: Object.fromEntries(action.params.map((param) => [param.id, param.schema])),
      labels: Object.fromEntries(
        action.params.map((param) => [param.id, sentence(param.name || param.id)])
      ),
      schemas: action.params.map((param) => param.schema),
      external: action.phases.writeback || action.phases.effects,
      writeback: action.phases.writeback,
      effects: action.phases.effects,
    }
  }, [call.kind, callId, action, workflow])
}

function cardCall(held: HeldCall, approval: AgentApproval | null): CardCall {
  const call = approval?.call
  if (call?.kind === "action") {
    return {
      kind: "action",
      actionId: call.actionId,
      ...(call.subject.kind === "object"
        ? {
            subject: { objectTypeId: call.subject.objectTypeId, primaryId: call.subject.primaryId },
          }
        : {}),
      params: call.params,
      effect: call.effect,
    }
  }
  if (call?.kind === "workflow") {
    return { kind: "workflow", workflowId: call.workflowId, input: call.input }
  }

  return held.kind === "action"
    ? {
        kind: "action",
        actionId: held.actionId,
        ...(held.subject ? { subject: held.subject } : {}),
      }
    : { kind: "workflow", workflowId: held.workflowId }
}

/** What a call's status and outcome say about it, from its record or its reported outcome. */
function stateOf(
  status: AgentApproval["status"],
  outcome: AgentApproval["outcome"]
): Exclude<CardState, "unknown" | "asked"> {
  if (status !== "approved") return status
  if (!outcome) return "running"
  if (outcome.kind === "error") {
    return outcome.error.code === "agent.approval_authority_lost" ? "lost" : "failed"
  }
  if (outcome.kind === "action-run" && outcome.status === "failed") return "failed"
  return "ran"
}
