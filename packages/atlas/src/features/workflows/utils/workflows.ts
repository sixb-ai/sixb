import type {
  GetWorkflowResponse,
  GetWorkflowRunResponse,
  ListWorkflowRunsResponse,
  ListWorkflowsResponse,
} from "@sixb/client"

export type WorkflowSummary = ListWorkflowsResponse[number]
export type WorkflowDetail = GetWorkflowResponse
export type WorkflowNode = WorkflowDetail["nodes"][number]
export type WorkflowRunSummary = ListWorkflowRunsResponse["runs"][number]
export type WorkflowRunDetail = GetWorkflowRunResponse["run"]
export type WorkflowRunNode = GetWorkflowRunResponse["nodes"][number]
export type WorkflowRunStatus = WorkflowRunSummary["status"]
export type WorkflowNodeStatus = WorkflowRunNode["status"]
export type WorkflowRunStatusFilter = WorkflowRunStatus | "all"

export const RUN_HISTORY_PAGE_SIZE = 20
export const allWorkflowRunStatuses = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly WorkflowRunStatus[]

export const statusLabels: Record<WorkflowRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
}

export const statusClasses: Record<WorkflowRunStatus, string> = {
  queued:
    "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300",
  running:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  waiting:
    "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-300",
  succeeded:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
  failed:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
  cancelled:
    "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300",
}

export const nodeStatusClasses: Record<WorkflowNodeStatus, string> = {
  running: statusClasses.running,
  waiting: statusClasses.waiting,
  succeeded: statusClasses.succeeded,
  failed: statusClasses.failed,
  cancelled: statusClasses.cancelled,
}

export function isWorkflowRunStatus(value: string | null): value is WorkflowRunStatus {
  return allWorkflowRunStatuses.some((status) => status === value)
}

export function readStatusFilter(value: string): WorkflowRunStatusFilter {
  return isWorkflowRunStatus(value) ? value : "all"
}

export function isActiveRunStatus(status: WorkflowRunStatus): boolean {
  return status === "queued" || status === "running" || status === "waiting"
}

export function formatDate(value?: string): string {
  if (!value) return "Not recorded"

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

export function formatRelativeTime(value?: string): string {
  if (!value) return "Not recorded"

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  const diffMs = date.getTime() - Date.now()
  const absoluteMs = Math.abs(diffMs)
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 1000 * 60 * 60 * 24 * 365],
    ["month", 1000 * 60 * 60 * 24 * 30],
    ["week", 1000 * 60 * 60 * 24 * 7],
    ["day", 1000 * 60 * 60 * 24],
    ["hour", 1000 * 60 * 60],
    ["minute", 1000 * 60],
    ["second", 1000],
  ]
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

  for (const [unit, unitMs] of units) {
    if (absoluteMs >= unitMs || unit === "second") {
      return formatter.format(Math.round(diffMs / unitMs), unit)
    }
  }

  return formatDate(value)
}

export function formatDurationFromMs(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "Not recorded"
  if (value < 1000) return "<1s"

  const seconds = Math.round(value / 1000)
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
  }

  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
}

export function formatRunDuration(run: WorkflowRunSummary | WorkflowRunDetail): string {
  return formatDuration(
    run.queuedAt ?? run.startedAt,
    run.finishedAt,
    isActiveRunStatus(run.status)
  )
}

export function formatRunStartedDate(run: WorkflowRunSummary | WorkflowRunDetail): string {
  return run.status === "queued" ? "Not started" : formatDate(run.startedAt)
}

export function formatNodeDuration(node: WorkflowRunNode): string {
  return formatDuration(
    node.startedAt,
    node.finishedAt,
    node.status === "running" || node.status === "waiting"
  )
}

export function runTimeLabel(run: WorkflowRunSummary | WorkflowRunDetail): string {
  if (run.status === "queued") return `Queued ${formatRelativeTime(run.queuedAt ?? run.startedAt)}`
  if (run.status === "running") return `Started ${formatRelativeTime(run.startedAt)}`
  if (run.status === "waiting") return `Waiting since ${formatRelativeTime(run.startedAt)}`
  if (run.finishedAt) return `Finished ${formatRelativeTime(run.finishedAt)}`
  return `Started ${formatRelativeTime(run.startedAt)}`
}

function timestampMs(value?: string): number | null {
  if (!value) return null

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.getTime()
}

function formatDuration(start?: string, end?: string, active = false): string {
  const startedAt = timestampMs(start)
  if (startedAt === null) return "Not recorded"

  const finishedAt = timestampMs(end) ?? (active ? Date.now() : null)
  if (finishedAt === null) return "Not recorded"

  return formatDurationFromMs(finishedAt - startedAt)
}
