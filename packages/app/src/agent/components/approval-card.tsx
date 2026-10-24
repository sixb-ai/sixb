import { getActionOptions, getObjectTypeOptions, getWorkflowOptions } from "@sixb/client/hooks"
import { Button, Spinner } from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowUpRight,
  Box,
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
  SkipForward,
  Workflow,
} from "lucide-react"
import { Fragment, type ReactNode, type Ref, useId, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { humanizeIdentifier } from "../../pages/ontology/lib/labels"
import { actionRunHref, objectHref, workflowRunHref } from "../../pages/routes"
import { useValueTypes, ValueTree, valueSchema } from "../../pages/values"
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
import { formatRelativeTime } from "../format"
import { useAgentMessages } from "../i18n"
import type { AgentMessages } from "../i18n/en"
import { objectContextTitleQuery } from "../object-context-title"
import { samePrincipal } from "../sharing"

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
export function ApprovalCard({ held }: { readonly held: HeldCall }) {
  const messages = useAgentMessages()
  const labels = messages.approvals
  const locale = useLocale()
  const alsoId = useId()
  const statusRef = useRef<HTMLParagraphElement>(null)
  const { approvals: context, outcomes } = useApprovalCards()
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

  const canDecide =
    state === "pending" && approval !== null && context?.decide !== undefined
      ? context.canDecide(approval)
      : false
  const requester = approval && context ? context.requesterName(approval) : null
  // Stopping applies to the whole paused turn: its first waiting card offers it.
  const canStop =
    state === "pending" &&
    approval !== null &&
    context?.stop !== undefined &&
    (context.canStop?.(approval) ?? false) &&
    context.approvals.find((other) => other.runId === approval.runId && other.status === "pending")
      ?.id === approval.id
  // A waiting call shows what it runs with; a decided one keeps it a click away.
  const waiting = state === "pending" || state === "unknown"
  const open = waiting || (approval !== null && showInput)
  const when = approval ? (approval.decidedAt ?? approval.createdAt) : undefined
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
        requestAnimationFrame(() => statusRef.current?.focus())
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
        // The buttons are gone: keep the reader's place on the card, which now says how it ended.
        requestAnimationFrame(() => statusRef.current?.focus())
      })
  }

  return (
    <section
      aria-label={labels.card(title)}
      aria-busy={deciding !== null}
      data-approval-state={state}
      className={cn(
        "min-w-0 overflow-hidden rounded-2xl border bg-card text-card-foreground",
        canDecide
          ? "border-amber-500/35 shadow-[0_0_0_4px_rgb(245_158_11/0.06),0_1px_2px_0_rgb(0_0_0/0.04)]"
          : "border-border shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]"
      )}
    >
      <div className="px-4 pt-3 pb-3.5 sm:px-5">
        <div className="flex items-center gap-2">
          <StatusLine
            focusRef={statusRef}
            state={state}
            requester={requester}
            canDecide={canDecide}
            messages={messages}
          />
          {when ? (
            <span
              className={cn(
                "ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground",
                // On a phone, Stop waiting needs the room more than the time does.
                canStop && "max-sm:hidden"
              )}
            >
              {formatRelativeTime(when, locale, messages.time)}
            </span>
          ) : null}
          {canStop ? (
            <button
              type="button"
              onClick={stopWaiting}
              disabled={stopping || deciding !== null}
              title={labels.stopWaitingHint}
              className="-my-1 -mr-1.5 shrink-0 rounded-md max-sm:ml-auto px-1.5 py-1 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
            >
              {stopping ? labels.stoppingWaiting : labels.stopWaiting}
            </button>
          ) : null}
        </div>

        <h3 className="mt-2 text-[15px] leading-snug font-semibold tracking-[-0.01em] text-foreground">
          {title}
        </h3>

        {call.kind === "action" && call.subject ? <Subject subject={call.subject} /> : null}

        {waiting || state === "asked" ? null : (
          <Outcome
            state={state}
            outcome={approval?.outcome ?? reported?.outcome}
            expiredDays={expiredDays}
            messages={messages}
          >
            {approval ? (
              <button
                type="button"
                aria-expanded={showInput}
                onClick={() => setShowInput((value) => !value)}
                className="-ml-1 flex items-center gap-1 rounded-md px-1 py-0.5 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <ChevronRight
                  className={cn("size-3.5 transition-transform", showInput && "rotate-90")}
                  aria-hidden="true"
                />
                {showInput ? labels.hideInput : labels.showInput}
              </button>
            ) : null}
          </Outcome>
        )}
      </div>

      {open ? (
        <div className="border-t border-border/60 px-4 py-3 sm:px-5">
          <CallInput call={call} definition={definition} emptyLabel={labels.noInput} />
        </div>
      ) : null}

      {waiting ? <Effect call={call} external={definition.external} messages={messages} /> : null}

      {canDecide ? (
        <div className="border-t border-border/60 px-4 py-3 sm:px-5">
          <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={deciding !== null}
              onClick={() => decide("deny")}
              className="h-10 text-muted-foreground hover:text-foreground sm:h-8"
            >
              {deciding === "deny" ? <Spinner className="size-3.5" /> : null}
              {deciding === "deny" ? labels.denying : labels.deny}
            </Button>
            <span className="hidden sm:block sm:flex-1" />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={deciding !== null}
              onClick={() => decide("always")}
              aria-describedby={alsoApproved > 0 ? alsoId : undefined}
              className="order-last col-span-2 h-auto min-h-10 py-2 leading-tight whitespace-normal sm:order-none sm:min-h-8 sm:py-1.5"
            >
              {deciding === "always" ? <Spinner className="size-3.5" /> : null}
              {labels.alwaysAllow(alwaysModeLabel)}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={deciding !== null}
              onClick={() => decide("approve")}
              className="h-10 sm:h-8 sm:px-4"
            >
              {deciding === "approve" ? <Spinner className="size-3.5" /> : null}
              {deciding === "approve" ? labels.approving : labels.approve}
            </Button>
          </div>
          {alsoApproved > 0 ? (
            <p id={alsoId} className="mt-2 text-xs text-muted-foreground sm:text-right">
              {labels.alwaysAllowAlso(alsoApproved)}
            </p>
          ) : null}
        </div>
      ) : state === "pending" && requester !== null ? (
        <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
          {labels.onlyRequester(requester)}
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className={cn(
            "border-t border-border/60 px-4 py-2.5 text-xs sm:px-5",
            notice.tone === "warning" ? "text-amber-700 dark:text-amber-400" : "text-foreground"
          )}
        >
          {notice.text}
        </p>
      ) : null}

      {stopFailed ? (
        <p
          role="alert"
          className="border-t border-border/60 px-4 py-2.5 text-xs text-destructive sm:px-5"
        >
          {labels.stopFailed}
        </p>
      ) : null}

      {failure ? (
        <p
          role="alert"
          className="border-t border-border/60 px-4 py-2.5 text-xs text-destructive sm:px-5"
        >
          {labels.failures[failure]}
        </p>
      ) : null}
    </section>
  )
}

function StatusLine({
  focusRef,
  state,
  requester,
  canDecide,
  messages,
}: {
  /** Where focus goes once a decision removes the buttons. */
  readonly focusRef: Ref<HTMLParagraphElement>
  readonly state: CardState
  readonly requester: string | null
  readonly canDecide: boolean
  readonly messages: AgentMessages
}) {
  const labels = messages.approvals
  const { Icon, label, tone } = statusOf(state, requester, canDecide, messages)

  return (
    <p
      ref={focusRef}
      tabIndex={-1}
      role="status"
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-sm text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        tone === "waiting" && "text-amber-700 dark:text-amber-400",
        tone === "done" && "text-emerald-700 dark:text-emerald-400",
        tone === "error" && "text-destructive",
        tone === "muted" && "text-muted-foreground"
      )}
    >
      {state === "running" ? (
        <Spinner className="size-3.5 shrink-0" />
      ) : (
        <Icon
          className={cn("size-3.5 shrink-0", state === "pending" && "motion-safe:animate-pulse")}
          aria-hidden="true"
        />
      )}
      <span className="truncate">{label}</span>
      {state === "running" ? <span className="sr-only">{labels.running}</span> : null}
    </p>
  )
}

function statusOf(
  state: CardState,
  requester: string | null,
  canDecide: boolean,
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
        label: canDecide || requester === null ? labels.waitingYou : labels.waitingOther(requester),
        tone: "waiting",
      }
    case "unknown":
      return { Icon: CirclePause, label: messages.bash.heldForApproval, tone: "waiting" }
    case "running":
      return { Icon: CircleCheck, label: `${labels.approved} · ${labels.running}`, tone: "done" }
    case "ran":
      return { Icon: CircleCheck, label: `${labels.approved} · ${labels.ran}`, tone: "done" }
    case "failed":
      return { Icon: CircleAlert, label: labels.failed, tone: "error" }
    case "lost":
      return { Icon: CircleAlert, label: labels.notRun, tone: "error" }
    case "denied":
      return {
        Icon: CircleSlash,
        label: `${labels.denied} · ${labels.deniedDetail}`,
        tone: "muted",
      }
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

/** The record the action acts on: its type, its title, and a link to its page. */
function Subject({
  subject,
}: {
  readonly subject: { readonly objectTypeId: string; readonly primaryId: string }
}) {
  const labels = useAgentMessages().approvals
  const queryClient = useQueryClient()
  const objectType = useQuery({
    ...getObjectTypeOptions({ path: { objectTypeId: subject.objectTypeId } }),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  const title = useQuery(objectContextTitleQuery(queryClient, subject)).data ?? null
  const typeName = objectType.data?.name ?? humanizeIdentifier(subject.objectTypeId)
  const name = title ?? subject.primaryId

  return (
    <Link
      to={objectHref(subject.objectTypeId, subject.primaryId)}
      aria-label={labels.open(`${typeName} ${name}`)}
      className="group mt-2 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-lg bg-muted/60 py-1 pr-2 pl-1.5 text-[13px] outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-background ring-1 ring-border">
        <Box className="size-3 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
      </span>
      <span className="shrink-0 text-muted-foreground">{typeName}</span>
      <span className="min-w-0 truncate font-medium text-foreground">{name}</span>
      <ArrowUpRight
        className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
        aria-hidden="true"
      />
    </Link>
  )
}

/**
 * The values the call runs with, one per line, labelled and formatted as the action or workflow
 * declares them: a date reads as a date, an object reference as a link to it.
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
    <dl className="grid grid-cols-[minmax(4.5rem,max-content)_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px] leading-5">
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
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium tracking-wide uppercase">
                  {item}
                </span>
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

/** Whether the call stays in the project's data: the line that tells a reader what is at stake. */
function Effect({
  call,
  external,
  messages,
}: {
  readonly call: CardCall
  readonly external: boolean | undefined
  readonly messages: AgentMessages
}) {
  const effects = messages.approvals.effects
  const effect =
    call.kind === "action" ? (call.effect ?? (external ? "external" : undefined)) : null
  if (call.kind === "action" && effect === undefined) return null

  const { Icon, text, tone } =
    call.kind === "workflow"
      ? {
          Icon: Workflow,
          text: effects.workflow(sentence(call.workflowId)),
          tone: "strong" as const,
        }
      : effect === "external"
        ? { Icon: Globe, text: effects.external, tone: "strong" as const }
        : { Icon: Database, text: effects.ontology, tone: "quiet" as const }

  return (
    <p
      className={cn(
        "flex items-center gap-2 border-t border-border/60 px-4 py-2.5 text-xs sm:px-5",
        tone === "strong" ? "text-foreground" : "text-muted-foreground"
      )}
    >
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          tone === "strong" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
        )}
        aria-hidden="true"
      />
      {text}
    </p>
  )
}

/** How a decided call ended, then a way to its values and to the run it started. */
function Outcome({
  state,
  outcome,
  expiredDays,
  messages,
  children,
}: {
  readonly state: CardState
  readonly outcome: AgentApproval["outcome"]
  readonly expiredDays: number
  readonly messages: AgentMessages
  /** The disclosure of the call's values, when the card has them. */
  readonly children?: ReactNode
}) {
  const labels = messages.approvals
  const detail =
    state === "superseded"
      ? labels.supersededDetail
      : state === "cancelled"
        ? labels.cancelledDetail
        : state === "expired"
          ? labels.expiredDetail(expiredDays)
          : state === "lost"
            ? labels.authorityLost
            : state === "failed"
              ? failureMessage(outcome)
              : null

  const runLink =
    outcome?.kind === "action-run"
      ? actionRunHref(outcome.runId)
      : outcome?.kind === "workflow-run"
        ? workflowRunHref(outcome.runId)
        : null
  if (!detail && !runLink && !children) return null

  return (
    <div className="mt-2.5 space-y-1.5 text-xs text-muted-foreground">
      {detail ? (
        <p className={cn((state === "failed" || state === "lost") && "text-destructive")}>
          {detail}
        </p>
      ) : null}
      {children || runLink ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {children}
          {runLink ? (
            <Link
              to={runLink}
              className="inline-flex items-center gap-0.5 rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {labels.viewRun}
              <ArrowUpRight className="size-3" aria-hidden="true" />
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  )
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
