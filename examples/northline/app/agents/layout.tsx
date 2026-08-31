import { AgentWorkspaceProvider } from "@sixb/app/agents"
import type { PropsWithChildren } from "react"
import { NorthlineSidebarFooter, NorthlineSidebarHeader } from "../_components/app-shell"

export default function AgentsLayout({ children }: PropsWithChildren) {
  return (
    <AgentWorkspaceProvider
      sidebarHeader={<NorthlineSidebarHeader />}
      sidebarFooter={<NorthlineSidebarFooter />}
      sidebarWidth="12.5rem"
    >
      {children}
    </AgentWorkspaceProvider>
  )
}
