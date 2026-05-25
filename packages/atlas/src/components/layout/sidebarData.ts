import { createContext } from "react"

export interface ProjectSidebarData {
  objectCount: number
  datasetCount: number
  connectorCount: number
  syncCount: number
  pipelineCount: number
  ruleCount: number
  ontologyCount: number
  connected: boolean
}

export const SidebarDataContext = createContext<{
  sidebarData: ProjectSidebarData | null
  setSidebarData: (data: ProjectSidebarData | null) => void
}>({ sidebarData: null, setSidebarData: () => {} })
