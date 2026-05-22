import type { ProjectInfo } from "@pario/client"
import {
  Sidebar as ShadcnSidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  ThemeSwitcher,
  useSidebar,
} from "@pario/ui/components"
import { cn } from "@pario/ui/lib/utils"
import {
  Box,
  Cable,
  ChevronsLeft,
  ChevronsRight,
  Database,
  ExternalLink,
  LayoutGrid,
  ListChecks,
  RefreshCw,
  Workflow,
} from "lucide-react"

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
  Icon: React.ComponentType<{ className?: string }>
}

const projectNavItems: NavItem[] = [
  { id: "connectors", label: "Connectors", Icon: Cable },
  { id: "datasets", label: "Datasets", Icon: Database },
  { id: "syncs", label: "Syncs", Icon: RefreshCw },
  { id: "pipelines", label: "Pipelines", Icon: Workflow },
  { id: "ontology", label: "Ontology", Icon: LayoutGrid },
  { id: "home", label: "Objects", Icon: Box },
  { id: "rules", label: "Rules", Icon: ListChecks },
]

interface SidebarProps {
  selectedProject: ProjectInfo | null
  connected: boolean
  viewMode: ViewMode
  onViewChange: (mode: ViewMode) => void
  datasetCount?: number
  connectorCount?: number
  syncCount?: number
  pipelineCount?: number
  ruleCount?: number
  ontologyCount?: number
  objectCount?: number
}

export function Sidebar({
  selectedProject,
  connected,
  viewMode,
  onViewChange,
  datasetCount,
  connectorCount,
  syncCount,
  pipelineCount,
  ruleCount,
  ontologyCount,
  objectCount,
}: SidebarProps) {
  const getCount = (id: ViewMode): number | undefined => {
    if (id === "home") return objectCount
    if (id === "datasets") return datasetCount
    if (id === "connectors") return connectorCount
    if (id === "syncs") return syncCount
    if (id === "pipelines") return pipelineCount
    if (id === "rules") return ruleCount
    if (id === "ontology") return ontologyCount
    return undefined
  }

  return (
    <ShadcnSidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-3 px-2 py-2 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:justify-center">
          {/* Avatar */}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-sidebar-border bg-sidebar-accent text-sm font-semibold text-sidebar-accent-foreground">
            {selectedProject ? selectedProject.name[0]?.toUpperCase() : "P"}
          </div>
          {/* Name + status */}
          <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
            {selectedProject ? (
              <>
                <p className="truncate text-sm font-semibold text-sidebar-foreground">
                  {selectedProject.name}
                </p>
                <p className="truncate text-xs text-sidebar-foreground">{selectedProject.type}</p>
              </>
            ) : (
              <p className="text-sm font-medium text-sidebar-foreground">Loading…</p>
            )}
          </div>
          {/* Connection dot */}
          {selectedProject ? (
            <div
              className="relative flex h-2 w-2 shrink-0 group-data-[collapsible=icon]:hidden"
              title={connected ? "Live" : "Disconnected"}
            >
              <span
                className={cn(
                  "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
                  connected ? "bg-emerald-500" : "bg-red-500"
                )}
              />
              <span
                className={cn(
                  "relative inline-flex h-2 w-2 rounded-full",
                  connected ? "bg-emerald-500" : "bg-red-500"
                )}
              />
            </div>
          ) : null}
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {projectNavItems.map((item) => {
                const count = getCount(item.id)
                const isActive = viewMode === item.id
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={isActive}
                      tooltip={item.label}
                      onClick={() => onViewChange(item.id)}
                    >
                      <item.Icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                    {count !== undefined && count > 0 ? (
                      <SidebarMenuBadge>{count}</SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarCollapseToggle />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <div className="flex items-center justify-between gap-2 px-2 group-data-[collapsible=icon]:hidden">
          <ThemeSwitcher />
          <a
            href={`http://${window.location.hostname}:3000/docs`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-sidebar-foreground transition-colors hover:text-sidebar-accent-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            API
          </a>
        </div>
      </SidebarFooter>

      <SidebarRail />
    </ShadcnSidebar>
  )
}

function SidebarCollapseToggle() {
  const { state, toggleSidebar } = useSidebar()
  const collapsed = state === "collapsed"
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar"
  const Icon = collapsed ? ChevronsRight : ChevronsLeft

  return (
    <SidebarMenuButton
      onClick={toggleSidebar}
      tooltip={`${label} (⌘B)`}
      aria-label={label}
      className="text-sidebar-foreground"
    >
      <Icon />
      <span>{label}</span>
    </SidebarMenuButton>
  )
}
