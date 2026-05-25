import { Route, Routes } from "react-router-dom"
import { AppLayout } from "./components/layout"
import { ProjectWorkspace } from "./pages/ProjectWorkspace"

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="*" element={<ProjectWorkspace />} />
      </Route>
    </Routes>
  )
}
