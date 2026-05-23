import { client } from "@sixb/client"
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
import { Activity, GitBranch, History } from "lucide-react"
import type { ComponentType } from "react"

export type ViewMode = "workflows" | "runs"

interface ProjectSummary {
  readonly name: string
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
  viewMode: ViewMode
  onViewChange: (mode: ViewMode) => void
  workflowCount?: number
  runCount?: number
}

export function Sidebar({
  selectedProject,
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
        <div className="flex items-center gap-3 px-2 py-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground">
            <Activity className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
            <p className="truncate text-sm font-semibold text-sidebar-foreground">Sentinel</p>
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
        <SidebarUserMenu user={user} apiHref={apiDocsUrl()} onSignOut={handleSignOut} />
      </SidebarFooter>

      <SidebarRail />
    </ShadcnSidebar>
  )
}
