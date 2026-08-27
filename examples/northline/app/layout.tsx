import type { AppMetadata } from "@sixb/app"
import { AgentWorkspaceProvider } from "@sixb/app/agents"
import { SixbEventsProvider } from "@sixb/client/hooks"
import { ThemeProvider } from "@sixb/ui/hooks"
import type { PropsWithChildren } from "react"
import { AppShell, NorthlineSidebarFooter, NorthlineSidebarHeader } from "./_components/app-shell"

export const metadata = {
  title: "Northline Operations",
  description: "Connected service operations for Northline Mechanical.",
  favicon: "/favicon.svg",
  themeColor: "#132a33",
  backgroundColor: "#f5f7f7",
} satisfies AppMetadata

export default function RootLayout({ children }: PropsWithChildren) {
  return (
    <ThemeProvider>
      <SixbEventsProvider>
        <AgentWorkspaceProvider
          sidebarHeader={<NorthlineSidebarHeader />}
          sidebarFooter={<NorthlineSidebarFooter />}
          sidebarWidth="12.5rem"
        >
          <AppShell>{children}</AppShell>
        </AgentWorkspaceProvider>
      </SixbEventsProvider>
    </ThemeProvider>
  )
}
