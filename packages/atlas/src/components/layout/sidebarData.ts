import { createContext } from "react"

export interface ProjectSidebarData {
  objectCount?: number
  workflowCount: number
  actionCount: number
}

export const SidebarDataContext = createContext<{
  sidebarData: ProjectSidebarData | null
  setSidebarData: (data: ProjectSidebarData | null) => void
}>({ sidebarData: null, setSidebarData: () => {} })
