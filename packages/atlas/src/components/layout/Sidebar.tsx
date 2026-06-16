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
  Box,
  Cable,
  Database,
  GitBranch,
  Globe,
  LayoutGrid,
  ListChecks,
  RefreshCw,
  Settings,
  Workflow,
} from "lucide-react"

export type ViewMode =
  | "home"
  | "datasets"
  | "connectors"
  | "syncs"
  | "pipelines"
  | "workflows"
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
  { id: "workflows", label: "Workflows", Icon: GitBranch },
  { id: "ontology", label: "Ontology", Icon: LayoutGrid },
  { id: "home", label: "Objects", Icon: Box },
  { id: "rules", label: "Rules", Icon: ListChecks },
  { id: "settings", label: "Settings", Icon: Settings },
]

function apiDocsUrl(): string {
  return new URL("/docs", client.getConfig().baseUrl ?? window.location.origin).toString()
}

interface SidebarProps {
  selectedProject: ProjectInfo | null
  viewMode: ViewMode
  onViewChange: (mode: ViewMode) => void
  datasetCount?: number
  connectorCount?: number
  syncCount?: number
  pipelineCount?: number
  workflowCount?: number
  ruleCount?: number
  ontologyCount?: number
  objectCount?: number
}

export function Sidebar({
  selectedProject,
  viewMode,
  onViewChange,
  datasetCount,
  connectorCount,
  syncCount,
  pipelineCount,
  workflowCount,
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
    if (id === "workflows") return workflowCount
    if (id === "rules") return ruleCount
    if (id === "ontology") return ontologyCount
    return undefined
  }

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
  const handleSignOut = () => {
    signOut.mutate({}, { onSettled: () => window.location.reload() })
  }

  return (
    <ShadcnSidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-3 px-2 py-2 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:justify-center">
          {/* App icon */}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground">
            <Globe className="h-4 w-4" />
          </div>
          {/* App name + project slug */}
          <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
            <p className="truncate text-sm font-semibold text-sidebar-foreground">Atlas</p>
            <p className="truncate text-xs text-sidebar-foreground">
              {selectedProject ? selectedProject.name : "Loading project"}
            </p>
          </div>
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
        <SidebarUserMenu user={user} apiHref={apiDocsUrl()} onSignOut={handleSignOut} />
      </SidebarFooter>

      <SidebarRail />
    </ShadcnSidebar>
  )
}
