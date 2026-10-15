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
  History,
  Layers,
  LayoutGrid,
  ListChecks,
  Network,
  RefreshCw,
  ScrollText,
  Search,
  Settings,
  Workflow,
} from "lucide-react"
import { projectAppUrl } from "../../lib/app-url"

export type ViewMode = "agents"

interface NavItem {
  id: ViewMode
  label: string
  Icon: React.ComponentType<{ className?: string }>
}

interface AppLink {
  /** The page's path in the project's app, where it moved. */
  appPath: string
  label: string
  Icon: React.ComponentType<{ className?: string }>
}

const projectNavGroups: { label: string; items: (NavItem | AppLink)[] }[] = [
  {
    label: "Data",
    items: [
      { appPath: "/data/connectors", label: "Connectors", Icon: Cable },
      { appPath: "/data/datasets", label: "Datasets", Icon: Database },
      { appPath: "/data/syncs", label: "Syncs", Icon: RefreshCw },
      { appPath: "/data/pipelines", label: "Pipelines", Icon: Workflow },
      { appPath: "/data/projections", label: "Projections", Icon: Layers },
    ],
  },
  {
    label: "Model",
    items: [
      { appPath: "/ontology/object-types", label: "Object types", Icon: LayoutGrid },
      { appPath: "/ontology/objects", label: "Objects", Icon: Box },
      { appPath: "/ontology/graph", label: "Graph", Icon: Network },
    ],
  },
  {
    label: "Automate",
    items: [
      { appPath: "/ontology/actions", label: "Actions", Icon: Bolt },
      { appPath: "/ontology/workflows", label: "Workflows", Icon: GitBranch },
      { id: "agents", label: "Agent", Icon: Bot },
    ],
  },
  {
    label: "Observability",
    items: [
      { appPath: "/observability/runs", label: "Runs", Icon: History },
      { appPath: "/observability/logs", label: "Logs", Icon: ScrollText },
      { appPath: "/observability/ai-usage", label: "AI usage", Icon: ChartNoAxesCombined },
    ],
  },
  {
    label: "Operate",
    items: [{ appPath: "/ontology/rules", label: "Rules", Icon: ListChecks }],
  },
]

function apiDocsUrl(): string {
  return new URL("/docs", client.getConfig().baseUrl ?? window.location.origin).toString()
}

interface SidebarProps {
  selectedProject: ProjectInfo | null
  viewMode: ViewMode | null
  onViewChange: (mode: ViewMode) => void
  onOpenCommand: () => void
}

export function Sidebar({ selectedProject, viewMode, onViewChange, onOpenCommand }: SidebarProps) {
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

        {projectNavGroups
          // A group of pages that all moved to the app shows only when Atlas can link there.
          .filter((group) => projectAppUrl("/") || group.items.some((item) => !("appPath" in item)))
          .map((group) => (
            <SidebarGroup key={group.label} className="py-1">
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    if ("appPath" in item) return <AppLinkItem key={item.appPath} link={item} />
                    const isActive = viewMode === item.id
                    return (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          isActive={isActive}
                          tooltip={item.label}
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
                      </SidebarMenuItem>
                    )
                  })}
                  {group.label === "Operate" ? (
                    <AppLinkItem
                      link={{ appPath: "/settings", label: "Settings", Icon: Settings }}
                    />
                  ) : null}
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

// A page that moved into the project's app; Atlas links there when it knows the app's address.
function AppLinkItem({ link }: { link: AppLink }) {
  const href = projectAppUrl(link.appPath)
  if (!href) return null
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip={link.label}>
        <a href={href}>
          <link.Icon />
          <span className="min-w-0 flex-1 truncate">{link.label}</span>
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
