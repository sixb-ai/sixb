import { Database, ListChecks, RefreshCw, Workflow } from "lucide-react"
import { cn } from "../../lib/utils"

export type ViewMode =
  | "home"
  | "datasets"
  | "connectors"
  | "syncs"
  | "pipelines"
  | "rules"
  | "ontology"

interface NavItem {
  id: ViewMode
  label: string
  icon: React.ReactNode
}

interface SidebarNavProps {
  viewMode: ViewMode
  onViewChange: (mode: ViewMode) => void
  objectCount?: number
  datasetCount?: number
  connectorCount?: number
  syncCount?: number
  pipelineCount?: number
  ruleCount?: number
  ontologyCount?: number
}

const projectNavItems: NavItem[] = [
  {
    id: "home",
    label: "Objects",
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
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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

export function SidebarNav({
  viewMode,
  onViewChange,
  objectCount,
  datasetCount,
  connectorCount,
  syncCount,
  pipelineCount,
  ruleCount,
  ontologyCount,
}: SidebarNavProps) {
  const getCount = (id: ViewMode) => {
    if (id === "home" && objectCount !== undefined) return objectCount
    if (id === "datasets" && datasetCount !== undefined) return datasetCount
    if (id === "connectors" && connectorCount !== undefined) return connectorCount
    if (id === "syncs" && syncCount !== undefined) return syncCount
    if (id === "pipelines" && pipelineCount !== undefined) return pipelineCount
    if (id === "rules" && ruleCount !== undefined) return ruleCount
    if (id === "ontology" && ontologyCount !== undefined) return ontologyCount
    return undefined
  }

  return (
    <nav className="p-2">
      <ul className="space-y-1">
        {projectNavItems.map((item) => {
          const count = getCount(item.id)
          const isActive = viewMode === item.id

          return (
            <li key={item.id}>
              <button
                onClick={() => onViewChange(item.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                )}
              >
                {item.icon}
                <span className="flex-1 text-left">{item.label}</span>
                {count !== undefined && (
                  <span
                    className={cn(
                      "text-xs px-1.5 py-0.5 rounded-md",
                      isActive ? "bg-background/20" : "bg-accent"
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
