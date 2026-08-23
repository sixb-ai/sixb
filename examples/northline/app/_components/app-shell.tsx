import { events, objectQueryKeys, useInvalidateOnEvent } from "@sixb/client/hooks"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  ThemeSwitcher,
} from "@sixb/ui/components"
import {
  Bot,
  CalendarClock,
  ClipboardList,
  FileText,
  Gauge,
  Handshake,
  LayoutDashboard,
  Network,
  UsersRound,
} from "lucide-react"
import type { CSSProperties, PropsWithChildren } from "react"
import { Link, useLocation } from "react-router-dom"
import { GlobalSearch } from "./global-search"
import { OperationsAssistant } from "./operations-assistant"

const groups = [
  {
    label: "Workspace",
    items: [
      { href: "/", label: "Today", icon: LayoutDashboard },
      { href: "/service-cases", label: "Service cases", icon: ClipboardList },
      { href: "/dispatch", label: "Dispatch", icon: CalendarClock },
      { href: "/agents", label: "Agents", icon: Bot },
    ],
  },
  {
    label: "Business",
    items: [
      { href: "/quotes", label: "Quotes", icon: FileText },
      { href: "/contracts", label: "Contracts", icon: Handshake },
      { href: "/customers", label: "Customers", icon: Network },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/equipment", label: "Equipment", icon: Gauge },
      { href: "/technicians", label: "Technicians", icon: UsersRound },
    ],
  },
] as const

export function AppShell({ children }: PropsWithChildren) {
  const location = useLocation()
  const agentsActive = location.pathname.startsWith("/agents")
  useInvalidateOnEvent(events.objects(), () => [objectQueryKeys.all()], {
    debounceMs: 75,
    enabled: !agentsActive,
  })
  useInvalidateOnEvent(events.links(), () => [objectQueryKeys.all()], {
    debounceMs: 75,
    enabled: !agentsActive,
  })

  if (agentsActive) return children

  return (
    <SidebarProvider
      style={{ "--sidebar-width": "12.5rem" } as CSSProperties}
      className="h-svh min-h-0 overflow-hidden"
    >
      <Sidebar collapsible="offcanvas" className="border-sidebar-border">
        <SidebarHeader className="h-16 justify-center border-b border-sidebar-border px-4 py-2">
          <Link to="/" aria-label="Northline Operations">
            <img
              src="/brand/northline-wordmark-light.svg"
              alt="Northline Mechanical"
              className="h-10 w-auto"
            />
          </Link>
        </SidebarHeader>
        <SidebarContent className="py-2">
          {groups.map((group) => (
            <SidebarGroup key={group.label} className="px-2 py-1.5">
              <SidebarGroupLabel className="h-7 px-2 text-[10px] font-semibold tracking-[0.13em] uppercase opacity-65">
                {group.label}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const active =
                      item.href === "/"
                        ? location.pathname === "/"
                        : location.pathname.startsWith(item.href)
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          asChild
                          isActive={active}
                          className="h-9 px-2.5 text-[13px]"
                        >
                          <Link to={item.href}>
                            <item.icon />
                            <span>{item.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter className="border-t border-sidebar-border p-3">
          <div className="flex items-center gap-2.5 rounded-md px-1.5 py-1 text-xs">
            <span className="grid size-7 place-items-center rounded-full bg-sidebar-accent font-semibold">
              AD
            </span>
            <span className="min-w-0">
              <strong className="block truncate font-medium">Alex Dawson</strong>
              <span className="block truncate text-[11px] opacity-65">Service operations</span>
            </span>
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="h-svh min-h-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-3 bg-background px-3 sm:px-4">
          <SidebarTrigger className="md:hidden" />
          <GlobalSearch />
          <div className="ml-auto">
            <ThemeSwitcher />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1320px] px-6 py-8 max-sm:px-4 max-sm:py-5">
            {children}
          </div>
        </div>
      </SidebarInset>
      <OperationsAssistant />
    </SidebarProvider>
  )
}
