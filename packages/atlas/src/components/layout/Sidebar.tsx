import { client, type ProjectInfo } from "@sixb/client"
import { getAuthSessionOptions, signOutMutation } from "@sixb/client/hooks"
import {
  Sidebar as ShadcnSidebar,
  SidebarCollapseToggle,
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
  SidebarUserMenu,
} from "@sixb/ui/components"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  Bolt,
  Bot,
  Box,
  Cable,
  ChartNoAxesCombined,
  Database,
  GitBranch,
  Layers,
  LayoutGrid,
  ListChecks,
  RefreshCw,
  ScrollText,
  Settings,
  Workflow,
} from "lucide-react"

export type ViewMode =
  | "home"
  | "ai-usage"
  | "datasets"
  | "connectors"
  | "syncs"
  | "projections"
  | "pipelines"
  | "workflows"
  | "actions"
  | "agents"
  | "logs"
  | "rules"
  | "ontology"
  | "settings"

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
  { id: "projections", label: "Projections", Icon: Layers },
  { id: "ontology", label: "Ontology", Icon: LayoutGrid },
  { id: "home", label: "Objects", Icon: Box },
  { id: "actions", label: "Actions", Icon: Bolt },
  { id: "workflows", label: "Workflows", Icon: GitBranch },
  { id: "agents", label: "Agents", Icon: Bot },
  { id: "ai-usage", label: "AI usage", Icon: ChartNoAxesCombined },
  { id: "logs", label: "Logs", Icon: ScrollText },
  { id: "rules", label: "Rules", Icon: ListChecks },
  { id: "settings", label: "Settings", Icon: Settings },
]

function SixbMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 480 394"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M5.42 162.63 39.47 392.44 342.17 296.69 472.14 104.34 183.6 1.82C120.12 59.31 59.11 114.33 5.42 162.63Z"
        fill="currentColor"
      />
    </svg>
  )
}

function apiDocsUrl(): string {
  return new URL("/docs", client.getConfig().baseUrl ?? window.location.origin).toString()
}

interface SidebarProps {
  selectedProject: ProjectInfo | null
  viewMode: ViewMode
  onViewChange: (mode: ViewMode) => void
  onViewIntent?: (mode: ViewMode) => void
  datasetCount?: number
  connectorCount?: number
  syncCount?: number
  pipelineCount?: number
  projectionCount?: number
  workflowCount?: number
  actionCount?: number
  agentCount?: number
  ruleCount?: number
  ontologyCount?: number
  objectCount?: number
}

export function Sidebar({
  selectedProject,
  viewMode,
  onViewChange,
  onViewIntent,
  datasetCount,
  connectorCount,
  syncCount,
  pipelineCount,
  projectionCount,
  workflowCount,
  actionCount,
  agentCount,
  ruleCount,
  ontologyCount,
  objectCount,
}: SidebarProps) {
  const getCount = (id: ViewMode): number | undefined => {
    if (id === "home") return objectCount
    if (id === "datasets") return datasetCount
    if (id === "connectors") return connectorCount
    if (id === "syncs") return syncCount
    if (id === "projections") return projectionCount
    if (id === "pipelines") return pipelineCount
    if (id === "workflows") return workflowCount
    if (id === "actions") return actionCount
    if (id === "agents") return agentCount
    if (id === "rules") return ruleCount
    if (id === "ontology") return ontologyCount
    return undefined
  }

  return (
    <ShadcnSidebar collapsible="icon">
      <AtlasSidebarHeader selectedProject={selectedProject} />

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
                      onPointerEnter={() => onViewIntent?.(item.id)}
                      onPointerDown={() => onViewIntent?.(item.id)}
                      onFocus={() => onViewIntent?.(item.id)}
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

      <AtlasSidebarFooter />

      <SidebarRail />
    </ShadcnSidebar>
  )
}

export function AtlasSidebarHeader({ selectedProject }: { selectedProject: ProjectInfo | null }) {
  return (
    <SidebarHeader className="h-[54px] justify-center border-b border-sidebar-border">
      <div className="flex items-center gap-3 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
        {/* Sixb's orbit mark anchors Atlas to the website identity. */}
        <div className="flex h-8 w-8 shrink-0 items-center justify-center text-sidebar-accent-foreground">
          <SixbMark className="h-[18px] w-[22px]" />
        </div>
        <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          <p className="truncate text-[14px] font-semibold tracking-[-0.02em] text-sidebar-accent-foreground">
            Sixb Atlas
          </p>
          <p className="truncate text-[11px] text-sidebar-foreground">
            {selectedProject ? selectedProject.name : "Loading project"}
          </p>
        </div>
      </div>
    </SidebarHeader>
  )
}

export function AtlasSidebarFooter() {
  const session = useQuery(getAuthSessionOptions()).data
  const signOut = useMutation(signOutMutation())
  const user =
    session?.authenticated === true
      ? {
          name: session.user.displayName ?? session.user.email,
          email: session.user.displayName ? session.user.email : undefined,
          avatarUrl: session.user.avatarUrl,
        }
      : null

  return (
    <SidebarFooter className="border-t border-sidebar-border">
      <SidebarUserMenu
        user={user}
        apiHref={apiDocsUrl()}
        onSignOut={() => signOut.mutate({}, { onSettled: () => window.location.reload() })}
      />
    </SidebarFooter>
  )
}
