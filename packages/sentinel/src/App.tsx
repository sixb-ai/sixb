import { Navigate, Route, Routes } from "react-router-dom"
import { AppLayout } from "./components/layout"
import { useWorkflowLiveUpdates } from "./features/workflows/hooks/useWorkflowLiveUpdates"
import { RunDetailPage } from "./pages/RunDetailPage"
import { RunsPage } from "./pages/RunsPage"
import { WorkflowDetailPage } from "./pages/WorkflowDetailPage"
import { WorkflowsPage } from "./pages/WorkflowsPage"

export default function App() {
  useWorkflowLiveUpdates()

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<WorkflowsPage />} />
        <Route path="workflows/:workflowId" element={<WorkflowDetailPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:runId" element={<RunDetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
