import { Navigate, Route, Routes } from "react-router-dom"
import { AppLayout } from "./components/layout"
import { RunDetailPage } from "./pages/RunDetailPage"
import { RunsPage } from "./pages/RunsPage"
import { WorkflowDetailPage } from "./pages/WorkflowDetailPage"
import { WorkflowsPage } from "./pages/WorkflowsPage"

if (import.meta.hot) {
  import.meta.hot.accept()
}

export default function App() {
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
