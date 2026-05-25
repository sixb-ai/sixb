import type { KeyboardEvent, MouseEvent } from "react"
import { useNavigate } from "react-router-dom"
import type { WorkflowRunSummary } from "../utils/workflows"

const nestedInteractiveSelector =
  "a,button,input,select,textarea,[role='button'],[data-run-history-interactive]"

export function runDetailPath(runId: string): string {
  return `/runs/${runId}`
}

export function workflowDetailPath(workflowId: string): string {
  return `/workflows/${workflowId}`
}

export function useRunHistoryNavigation(run: Pick<WorkflowRunSummary, "id" | "workflowId">) {
  const navigate = useNavigate()
  const runPath = runDetailPath(run.id)
  const workflowPath = workflowDetailPath(run.workflowId)

  const openRun = () => navigate(runPath)

  const onContainerClick = (event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || isNestedInteractiveTarget(event)) return
    openRun()
  }

  const onContainerKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.target !== event.currentTarget) return
    if (event.key !== "Enter" && event.key !== " ") return

    event.preventDefault()
    openRun()
  }

  return {
    runPath,
    workflowPath,
    openRun,
    onContainerClick,
    onContainerKeyDown,
  }
}

function isNestedInteractiveTarget(event: MouseEvent<HTMLElement>): boolean {
  if (!(event.target instanceof Element)) return false

  const nested = event.target.closest(nestedInteractiveSelector)
  return !!nested && nested !== event.currentTarget && event.currentTarget.contains(nested)
}
