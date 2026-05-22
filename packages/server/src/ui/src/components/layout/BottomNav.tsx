import { Database, ListChecks, RefreshCw, Workflow } from "lucide-react"
import { cn } from "../../lib/utils"
import type { ViewMode } from "./SidebarNav"

interface BottomNavProps {
  viewMode: ViewMode
  onViewChange: (mode: ViewMode) => void
}

const items: { id: ViewMode; label: string; icon: React.ReactNode }[] = [
  {
    id: "home",
    label: "Assets",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
        />
      </svg>
    ),
  },
  {
    id: "datasets",
    label: "Datasets",
    icon: <Database className="h-5 w-5" />,
  },
  {
    id: "connectors",
    label: "Connectors",
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M9.75 6.75h-2.5A3.25 3.25 0 004 10v0a3.25 3.25 0 003.25 3.25h2.5m4.5 0h2.5A3.25 3.25 0 0020 10v0a3.25 3.25 0 00-3.25-3.25h-2.5M9 10h6"
        />
      </svg>
    ),
  },
  {
    id: "syncs",
    label: "Syncs",
    icon: <RefreshCw className="h-5 w-5" />,
  },
  {
    id: "pipelines",
    label: "Pipelines",
    icon: <Workflow className="h-5 w-5" />,
  },
  {
    id: "rules",
    label: "Rules",
    icon: <ListChecks className="h-5 w-5" />,
  },
  {
    id: "ontology",
    label: "Ontology",
    icon: (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
        />
      </svg>
    ),
  },
]

export function BottomNav({ viewMode, onViewChange }: BottomNavProps) {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-border/50 bg-card/90 backdrop-blur-xl md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="flex items-center justify-around px-2 py-1.5">
        {items.map((item) => {
          const active = viewMode === item.id
          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={cn(
                "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-1.5 py-1.5 transition-colors",
                active ? "text-primary dark:text-white" : "text-muted-foreground"
              )}
            >
              {item.icon}
              <span className="max-w-full truncate text-[10px] font-medium">{item.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
