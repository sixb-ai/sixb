import { Navigate, Route, Routes } from "react-router-dom"
import { AppLayout } from "./components/layout"
import { ProjectWorkspace } from "./pages/ProjectWorkspace"

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="agents" element={null} />
        <Route path="agents/new/:agentId" element={<Navigate to="/agents" replace />} />
        <Route path="agents/:threadId" element={null} />
        <Route path="*" element={<ProjectWorkspace />} />
      </Route>
    </Routes>
  )
}
