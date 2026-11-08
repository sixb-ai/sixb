import { useObjectsQuery } from "@sixb/client/hooks"
import { type ClientObjectQueryBuilder, objects } from "@sixb/client/query"
import { useMemo } from "react"
import { ServiceCase } from "../../ontology/service-case"
import { WorkOrder } from "../../ontology/work-order"
import type { Tone } from "../_components/ui"

/**
 * Every case not yet closed or cancelled. Filtered by the server, so a page's row limit never
 * spends itself on finished cases; pages add the links and order they need.
 */
export const openServiceCases: ClientObjectQueryBuilder<typeof ServiceCase> = objects(ServiceCase)
  .query()
  .where((serviceCase) =>
    serviceCase.and(serviceCase.p.status.neq("closed"), serviceCase.p.status.neq("cancelled"))
  )

/** Work orders not yet completed or cancelled: the jobs Dispatch schedules. */
export const openWorkOrders: ClientObjectQueryBuilder<typeof WorkOrder> = objects(WorkOrder)
  .query()
  .where((workOrder) =>
    workOrder.and(workOrder.p.status.neq("completed"), workOrder.p.status.neq("cancelled"))
  )

/** A case's page; without a case, the list of them. */
export function casePath(primaryId: string | undefined): string {
  return primaryId ? `/service-cases/${encodeURIComponent(primaryId)}` : "/service-cases"
}

/** Closed and cancelled cases are finished; every other status is open. */
export function isCaseOpen(status: string | undefined): boolean {
  return status !== "closed" && status !== "cancelled"
}

export interface CaseClockFields {
  readonly status?: string
  readonly slaStatus?: string
  readonly responseDeadline?: string | Date
  readonly resolutionDeadline?: string | Date
}

export interface CaseClock {
  /** Which commitment is running: "Response", "Resolution" or "Commitment" once it is over. */
  readonly label: string
  /** The clock on its own, for a labelled fact: "47m left", "2h overdue", "Met". */
  readonly value: string
  /** The clock as a phrase, for rows that have no label: "47m to respond". */
  readonly summary: string
  readonly tone: Extract<Tone, "critical" | "warning" | "neutral">
  /** When the running commitment falls due, for sorting; infinity once it is over. */
  readonly dueAt: number
}

const awaitingResponse = new Set(["new", "triage", "dispatching"])
const finished = new Set(["resolved", "closed", "cancelled"])

/**
 * The commitment that matters at a case's stage. Until a technician is on site the customer is
 * waiting on a response; after that, on a resolution, which pauses while the customer authorizes
 * a repair; once resolved, the commitment was met or missed.
 */
export function caseClock(serviceCase: CaseClockFields): CaseClock {
  const status = serviceCase.status ?? "new"
  const atRisk = serviceCase.slaStatus === "at_risk" || serviceCase.slaStatus === "breached"
  if (finished.has(status)) {
    const missed = serviceCase.slaStatus === "breached"
    return {
      label: "Commitment",
      value: missed ? "Missed" : "Met",
      summary: missed ? "Commitment missed" : "Commitment met",
      tone: missed ? "critical" : "neutral",
      dueAt: Number.POSITIVE_INFINITY,
    }
  }

  // Contracts stop the resolution clock while the customer decides on work outside coverage.
  if (status === "awaiting_authorization") {
    return {
      label: "Resolution",
      value: "Paused",
      summary: "Waiting on the customer",
      tone: "neutral",
      dueAt: Number.POSITIVE_INFINITY,
    }
  }

  const responding = awaitingResponse.has(status)
  const label = responding ? "Response" : "Resolution"
  const deadline = responding ? serviceCase.responseDeadline : serviceCase.resolutionDeadline
  if (!deadline) {
    const dueAt = Number.POSITIVE_INFINITY
    return { label, value: "No deadline", summary: "No deadline", tone: "neutral", dueAt }
  }

  const dueAt = new Date(deadline).getTime()
  const remaining = dueAt - Date.now()
  const duration = formatDuration(Math.abs(remaining))
  if (remaining < 0) {
    return {
      label,
      value: `${duration} overdue`,
      summary: `${label} ${duration} overdue`,
      tone: "critical",
      dueAt,
    }
  }
  return {
    label,
    value: `${duration} left`,
    summary: `${duration} to ${responding ? "respond" : "resolve"}`,
    tone: atRisk ? "warning" : "neutral",
    dueAt,
  }
}

/**
 * At risk is what a running clock shows: overdue, or flagged by the contract while time remains.
 * A finished case's missed commitment is history, not a risk.
 */
export function isCaseAtRisk(serviceCase: CaseClockFields): boolean {
  const clock = caseClock(serviceCase)
  return clock.tone !== "neutral" && Number.isFinite(clock.dueAt)
}

const severityWeight: Readonly<Record<string, number>> = {
  critical: 40,
  high: 30,
  medium: 20,
  low: 10,
}
const riskWeight: Readonly<Record<string, number>> = { critical: 30, warning: 20 }

/** Most urgent first: severity, then what the clock shows, then the soonest deadline. */
export function casePriority(
  serviceCase: CaseClockFields & { readonly severity?: string }
): number {
  const clock = caseClock(serviceCase)
  const closed = isCaseOpen(serviceCase.status) ? 0 : -100
  const dueAt = Number.isFinite(clock.dueAt) ? clock.dueAt : Date.now()
  return (
    (severityWeight[serviceCase.severity ?? "low"] ?? 0) +
    (riskWeight[clock.tone] ?? 0) +
    closed -
    dueAt / 1e13
  )
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

// What a case waits on someone at Northline to do, by status. The other open statuses wait on the
// field or the customer.
const decisions: Readonly<Record<string, string>> = {
  new: "Acknowledge",
  triage: "Dispatch",
  awaiting_authorization: "Review quote",
  resolved: "Close",
}

/**
 * The decision a case is waiting on, as a button label, or undefined when it waits on no one here.
 * A case in service whose field work is finished waits on someone to verify the unit recovered.
 */
export function caseDecision(
  status: string | undefined,
  fieldWorkDone = false
): string | undefined {
  if (status === "in_service" && fieldWorkDone) return "Verify recovery"
  return decisions[status ?? ""]
}

/** The case list's views; Home links straight into them. */
export const caseViews = [
  ["open", "Open"],
  ["action", "Needs you"],
  ["field", "In the field"],
  ["risk", "At risk"],
  ["all", "All"],
] as const

export type CaseView = (typeof caseViews)[number][0]

/** Whether a case belongs in a view; `fieldWorkDone` comes from `useCasesWithFieldWorkDone`. */
export function inCaseView(
  serviceCase: { readonly primaryId: string; readonly properties: CaseClockFields },
  view: CaseView,
  fieldWorkDone: ReadonlySet<string>
): boolean {
  const { status } = serviceCase.properties
  if (view === "all") return true
  if (!isCaseOpen(status)) return false
  if (view === "action") {
    return caseDecision(status, fieldWorkDone.has(serviceCase.primaryId)) !== undefined
  }
  if (view === "field") return status === "dispatching" || status === "in_service"
  if (view === "risk") return isCaseAtRisk(serviceCase.properties)
  return true
}

// Newest first, so the work behind cases still in service is never past the limit.
const completedWork = objects(WorkOrder)
  .query()
  .where((workOrder) => workOrder.p.status.eq("completed"))
  .expand(WorkOrder.l.serviceCase)
  .orderBy(WorkOrder.p.scheduledStart, "desc")
  .limit(200)

/** The cases with completed field work, for `caseDecision`. */
export function useCasesWithFieldWorkDone(): ReadonlySet<string> {
  const workOrders = useObjectsQuery(completedWork, { staleTime: 30_000 })
  return useMemo(
    () =>
      new Set(
        (workOrders.data?.objects ?? []).flatMap((workOrder) =>
          workOrder.links.serviceCase ? [workOrder.links.serviceCase.primaryId] : []
        )
      ),
    [workOrders.data]
  )
}
