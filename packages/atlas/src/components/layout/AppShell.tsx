import { SidebarInset, SidebarProvider, SidebarTrigger } from "@sixb/ui/components"
import type { ReactNode } from "react"

interface AppShellProps {
  sidebar: ReactNode
  children: ReactNode
  currentProjectName: string | null
}

export function AppShell({ sidebar, children, currentProjectName }: AppShellProps) {
  return (
    <SidebarProvider className="atlas-shell h-dvh overflow-hidden">
      {sidebar}
      <SidebarInset className="min-h-0 overflow-hidden">
        {/* Mobile-only header: gives users a way to open the sheet. */}
        <header className="atlas-mobile-header flex h-[54px] shrink-0 items-center gap-3 border-b border-border px-3 md:hidden">
          <SidebarTrigger className="-ml-1" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">Sixb Atlas</p>
            {currentProjectName ? (
              <p className="truncate text-[11px] text-muted-foreground">{currentProjectName}</p>
            ) : null}
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}
