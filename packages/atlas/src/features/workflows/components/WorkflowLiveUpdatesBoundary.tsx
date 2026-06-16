import { Outlet } from "react-router-dom"
import { useWorkflowLiveUpdates } from "../hooks/useWorkflowLiveUpdates"

export function WorkflowLiveUpdatesBoundary() {
  useWorkflowLiveUpdates()

  return <Outlet />
}
