import type {
  GetWorkflowAgentNodeExecutionResponse,
  GetWorkflowResponse,
  GetWorkflowRunResponse,
  ListWorkflowRunsResponse,
  ListWorkflowsResponse,
} from "@sixb/client"
import { formatDuration as formatSpan } from "../../section-ui"
import { fieldRecordSchema } from "../../values"
import { formatRelativeTime } from "../lib/time"

export type WorkflowSummary = ListWorkflowsResponse[number]
export type WorkflowDetail = GetWorkflowResponse
export type WorkflowNode = WorkflowDetail["nodes"][number]
type WorkflowRunSummary = ListWorkflowRunsResponse["runs"][number]
export type WorkflowRunDetail = GetWorkflowRunResponse["run"]
export type WorkflowRunNode = GetWorkflowRunResponse["nodes"][number]
export type WorkflowAgentNodeExecution = GetWorkflowAgentNodeExecutionResponse
export type WorkflowRunStatus = WorkflowRunSummary["status"]
export type WorkflowNodeStatus = WorkflowRunNode["status"]
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

/**
 * The declared schemas of what a node's runs record, as `object` schemas.
 * `output` is null where nothing declares it: an action node records only the
 * id of the action run it requested.
 */
export function workflowNodeIoSchemas(node: WorkflowNode): {
  readonly input: unknown
  readonly output: unknown | null
} {
  switch (node.type) {
    case "step":
    case "agent":
      return { input: fieldRecordSchema(node.input), output: fieldRecordSchema(node.output) }
    case "intervention":
      return { input: fieldRecordSchema(node.input), output: fieldRecordSchema(node.response) }
    case "action":
      // Recorded as `{ params, subject? }`. The subject is the run's own
      // `{ kind, objectTypeId, primaryId }` record, not a declared value.
      return {
        input: {
          type: "object",
          properties: { params: { schema: fieldRecordSchema(node.params) } },
        },
        output: null,
      }
  }
}

/** Every schema a workflow declares, as sources of value types. */
export function workflowSchemas(workflow: WorkflowDetail): unknown[] {
  return [
    fieldRecordSchema(workflow.input),
    ...workflow.nodes.flatMap((node) => {
      const io = workflowNodeIoSchemas(node)
      return io.output === null ? [io.input] : [io.input, io.output]
    }),
  ]
}

// A run still going is measured up to now.
function formatDuration(start: string | undefined, end: string | undefined, active: boolean) {
  return formatSpan(start, end ?? (active ? new Date().toISOString() : undefined))
}
