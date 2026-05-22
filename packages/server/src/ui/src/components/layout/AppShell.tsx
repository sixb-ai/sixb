import type { ReactNode } from "react"
import { cn } from "../../lib/utils"
import { ThemeSwitcher } from "../common"
import { BottomNav } from "./BottomNav"
import { MobileProjectSwitcher } from "./MobileProjectSwitcher"
import type { ViewMode } from "./SidebarNav"

interface AppShellProps {
  sidebar: ReactNode
  children: ReactNode
  currentProjectName: string | null
  viewMode: ViewMode
  onViewChange: (mode: ViewMode) => void
}

export function AppShell({
  sidebar,
  children,
  currentProjectName,
  viewMode,
  onViewChange,
}: AppShellProps) {
  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {/* Sidebar — permanent on md+, hidden on mobile */}
      <div className="hidden md:flex md:h-full md:w-64 md:shrink-0">{sidebar}</div>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile header */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border/50 bg-background px-4 md:hidden">
          <MobileProjectSwitcher currentProjectName={currentProjectName} />
          <ThemeSwitcher compact />
        </header>

        {/* Scrollable content area */}
        <main className={cn("min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-14 md:pb-0")}>
          {children}
        </main>
      </div>

      {/* Bottom navigation on mobile */}
      <BottomNav viewMode={viewMode} onViewChange={onViewChange} />
    </div>
  )
}
