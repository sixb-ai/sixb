import { client } from "@pario/client"
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
  Activity,
  ChevronsLeft,
  ChevronsRight,
  ExternalLink,
  GitBranch,
  History,
} from "lucide-react"
import type { ComponentType } from "react"

export type ViewMode = "workflows" | "runs"

interface ProjectSummary {
  readonly name: string
  readonly type: string
}

interface NavItem {
  id: ViewMode
  label: string
  Icon: ComponentType<{ className?: string }>
}

const navItems: NavItem[] = [
  { id: "workflows", label: "Workflows", Icon: GitBranch },
  { id: "runs", label: "Runs", Icon: History },
]

function apiDocsUrl(): string {
  return new URL("/docs", client.getConfig().baseUrl ?? window.location.origin).toString()
}

interface SidebarProps {
  selectedProject: ProjectSummary | null
  connected: boolean
  viewMode: ViewMode
  onViewChange: (mode: ViewMode) => void
  workflowCount?: number
  runCount?: number
}

export function Sidebar({
  selectedProject,
  connected,
  viewMode,
  onViewChange,
  workflowCount,
  runCount,
}: SidebarProps) {
  const getCount = (id: ViewMode): number | undefined => {
    if (id === "workflows") return workflowCount
    if (id === "runs") return runCount
    return undefined
  }

  return (
    <ShadcnSidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-3 px-2 py-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground">
            <Activity className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
            <p className="truncate text-sm font-semibold text-sidebar-foreground">Sentinel</p>
            <p className="truncate text-xs text-sidebar-foreground">
              {selectedProject
                ? `${selectedProject.name} · ${selectedProject.type}`
                : "Loading project"}
            </p>
          </div>
          {selectedProject ? (
            <div
              className="relative flex h-2 w-2 shrink-0 group-data-[collapsible=icon]:hidden"
              title={connected ? "API ready" : "Disconnected"}
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
              {navItems.map((item) => {
                const count = getCount(item.id)
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={viewMode === item.id}
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
            href={apiDocsUrl()}
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
