import { client, type ProjectInfo } from "@sixb/client"
import { getAuthSessionOptions, signOutMutation } from "@sixb/client/hooks"
import {
  Sidebar as ShadcnSidebar,
  SidebarCollapseToggle,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
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
  ArrowUpRight,
  Bolt,
  Bot,
  Box,
  Cable,
  ChartNoAxesCombined,
  ChevronRight,
  Database,
  GitBranch,
  Layers,
  LayoutGrid,
  ListChecks,
  RefreshCw,
  ScrollText,
  Search,
  Settings,
  Workflow,
} from "lucide-react"
import { projectAppUrl } from "../../lib/app-url"

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

interface NavItem {
  id: ViewMode
  label: string
  Icon: React.ComponentType<{ className?: string }>
}

const projectNavGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "Data",
    items: [
      { id: "connectors", label: "Connectors", Icon: Cable },
      { id: "datasets", label: "Datasets", Icon: Database },
      { id: "syncs", label: "Syncs", Icon: RefreshCw },
      { id: "pipelines", label: "Pipelines", Icon: Workflow },
      { id: "projections", label: "Projections", Icon: Layers },
    ],
  },
  {
    label: "Model",
    items: [
      { id: "ontology", label: "Ontology", Icon: LayoutGrid },
      { id: "home", label: "Objects", Icon: Box },
    ],
  },
  {
    label: "Automate",
    items: [
      { id: "actions", label: "Actions", Icon: Bolt },
      { id: "workflows", label: "Workflows", Icon: GitBranch },
      { id: "agents", label: "Agent", Icon: Bot },
    ],
  },
  {
    label: "Operate",
    items: [
      { id: "ai-usage", label: "AI usage", Icon: ChartNoAxesCombined },
      { id: "logs", label: "Logs", Icon: ScrollText },
      { id: "rules", label: "Rules", Icon: ListChecks },
    ],
  },
]

function apiDocsUrl(): string {
  return new URL("/docs", client.getConfig().baseUrl ?? window.location.origin).toString()
}

interface SidebarProps {
  selectedProject: ProjectInfo | null
  viewMode: ViewMode
  onViewChange: (mode: ViewMode) => void
  onViewIntent?: (mode: ViewMode) => void
  onOpenCommand: () => void
  workflowCount?: number
  actionCount?: number
  objectCount?: number
}

export function Sidebar({
  selectedProject,
  viewMode,
  onViewChange,
  onViewIntent,
  onOpenCommand,
  workflowCount,
  actionCount,
  objectCount,
}: SidebarProps) {
  const getCount = (id: ViewMode): number | undefined => {
    if (id === "home") return objectCount
    if (id === "workflows") return workflowCount
    if (id === "actions") return actionCount
    return undefined
  }

  return (
    <ShadcnSidebar collapsible="icon">
      <AtlasSidebarHeader selectedProject={selectedProject} />

      <SidebarContent>
        <SidebarGroup className="pt-1.5 pb-1">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Search"
                  onClick={onOpenCommand}
                  className="border border-sidebar-border bg-sidebar text-sidebar-foreground hover:border-foreground/15"
                >
                  <Search />
                  <span>Search</span>
                  <kbd className="ml-auto text-[10px] text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden">
                    ⌘K
                  </kbd>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {projectNavGroups.map((group) => (
          <SidebarGroup key={group.label} className="py-1">
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
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
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.id === "agents" ? (
                          <ChevronRight
                            aria-hidden="true"
                            className="ml-auto text-sidebar-foreground/55 group-data-[collapsible=icon]:hidden"
                          />
                        ) : null}
                      </SidebarMenuButton>
                      {count !== undefined && count > 0 ? (
                        <SidebarMenuBadge>{count}</SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  )
                })}
                {group.label === "Operate" ? <AppSettingsItem /> : null}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

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

// Settings moved into the project's app; Atlas links there when it knows the app's address.
function AppSettingsItem() {
  const href = projectAppUrl("/settings")
  if (!href) return null
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip="Settings">
        <a href={href}>
          <Settings />
          <span className="min-w-0 flex-1 truncate">Settings</span>
          <ArrowUpRight
            aria-hidden="true"
            className="ml-auto text-sidebar-foreground/55 group-data-[collapsible=icon]:hidden"
          />
        </a>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

export function AtlasSidebarHeader({ selectedProject }: { selectedProject: ProjectInfo | null }) {
  return (
    <SidebarHeader className="h-[50px] justify-center">
      <div className="flex items-center gap-2 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
        <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          <p className="truncate text-[14px] font-semibold leading-4 tracking-[-0.02em] text-sidebar-accent-foreground">
            Sixb Atlas
          </p>
          <p className="mt-0.5 truncate text-[11px] leading-4 text-sidebar-foreground/65">
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
