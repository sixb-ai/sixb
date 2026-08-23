import { Route, Routes } from "react-router-dom"
import { AppLayout } from "./components/layout"
import { AgentsPage } from "./pages/AgentsPage"
import { ProjectWorkspace } from "./pages/ProjectWorkspace"

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/new/:agentId" element={<AgentsPage />} />
        <Route path="agents/:threadId" element={<AgentsPage />} />
        <Route path="*" element={<ProjectWorkspace />} />
      </Route>
    </Routes>
  )
}
