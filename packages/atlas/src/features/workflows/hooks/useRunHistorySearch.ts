import { useSearchParams } from "react-router-dom"
import {
  isWorkflowRunStatus,
  RUN_HISTORY_PAGE_SIZE,
  type WorkflowRunStatusFilter,
} from "../utils/workflows"

export function useRunHistorySearch() {
  const [searchParams, setSearchParams] = useSearchParams()
  const statusParam = searchParams.get("status")
  const selectedStatus: WorkflowRunStatusFilter = isWorkflowRunStatus(statusParam)
    ? statusParam
    : "all"
  const selectedWorkflowId = searchParams.get("workflowId") || "all"
  const parsedPage = Number.parseInt(searchParams.get("page") ?? "0", 10)
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 0

  const updateSearch = (next: {
    status?: WorkflowRunStatusFilter
    workflowId?: string
    page?: number
  }) => {
    const params = new URLSearchParams(searchParams)

    if (next.status !== undefined) {
      if (next.status === "all") params.delete("status")
      else params.set("status", next.status)
      params.delete("page")
    }

    if (next.workflowId !== undefined) {
      if (next.workflowId === "all") params.delete("workflowId")
      else params.set("workflowId", next.workflowId)
      params.delete("page")
    }

    if (next.page !== undefined) {
      if (next.page <= 0) params.delete("page")
      else params.set("page", String(next.page))
    }

    setSearchParams(params)
  }

  return {
    selectedStatus,
    selectedWorkflowId,
    page,
    offset: page * RUN_HISTORY_PAGE_SIZE,
    filtered: selectedStatus !== "all" || selectedWorkflowId !== "all",
    clearSearch: () =>
      setSearchParams((previous) => {
        const params = new URLSearchParams()
        const tab = previous.get("tab")
        if (tab) params.set("tab", tab)
        return params
      }),
    updateSearch,
  }
}
