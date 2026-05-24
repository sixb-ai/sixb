import { SidebarInset, SidebarProvider, SidebarTrigger } from "@pario/ui/components"
import type { ReactNode } from "react"

interface AppShellProps {
  sidebar: ReactNode
  children: ReactNode
  currentProjectName: string | null
}

export function AppShell({ sidebar, children, currentProjectName }: AppShellProps) {
  return (
    <SidebarProvider className="h-dvh overflow-hidden">
      {sidebar}
      <SidebarInset className="min-h-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-3 md:hidden">
          <SidebarTrigger className="-ml-1" />
          <p className="truncate text-sm font-medium text-foreground">
            {currentProjectName ?? "Sentinel"}
          </p>
        </header>
        <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}
