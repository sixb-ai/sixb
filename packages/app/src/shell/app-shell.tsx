import {
  Sidebar,
  SidebarCollapseToggle,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@sixb/ui/components"
import { ThemeProvider } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { MessageSquareText } from "lucide-react"
import type { CSSProperties, ReactNode } from "react"
import { setAgentSurfaceMode } from "../agent/agent-surface-state"
import { useAppMessages } from "../locale"
import { AgentDock } from "./agent-dock"
import { Brand } from "./brand"
import { type NavEntry, type NavItem, NavItems } from "./nav-items"
import { PhoneMoreSheet } from "./phone/more-sheet"
import { PhoneTabBar } from "./phone/tab-bar"
import { PhoneTopBar } from "./phone/top-bar"
import { SearchCommand } from "./search-command"
import { SectionNav } from "./section-nav"
import { UserMenu } from "./user-menu"

export interface AppShellProviderProps {
  readonly defaultOpen?: boolean
  readonly open?: boolean
  readonly onOpenChange?: (open: boolean) => void
  readonly className?: string
  /** Such as `--sidebar-width`. */
  readonly style?: CSSProperties
  readonly children: ReactNode
}

/**
 * What every Sixb shell sits in: the theme, the sidebar's open state and its ⌘B shortcut, and a
 * full-height frame. `AppShell` is made of this, and a shell assembled by hand starts here too.
 */
export function AppShellProvider({ className, children, ...sidebarState }: AppShellProviderProps) {
  return (
    <ThemeProvider>
      <SidebarProvider className={cn("h-dvh overflow-hidden", className)} {...sidebarState}>
        {children}
      </SidebarProvider>
    </ThemeProvider>
  )
}

export interface AppShellProps {
  /** Links and groups as data, or your own sidebar content. */
  readonly nav?: readonly NavEntry[] | ReactNode
  /** Replaces the app's name and mark. */
  readonly brand?: ReactNode
  /** Shown below the brand; ⌘K search by default, `null` removes it. */
  readonly header?: ReactNode
  /** Shown above the user menu. */
  readonly footer?: ReactNode
  /** Replaces the user menu; `null` removes it. */
  readonly userMenu?: ReactNode
  /** Beside every page; the project's agent, docked, by default. `null` removes it. */
  readonly agent?: ReactNode
  readonly variant?: "sidebar" | "floating" | "inset"
  readonly collapsible?: "offcanvas" | "icon" | "none"
  readonly side?: "left" | "right"
  readonly defaultOpen?: boolean
  readonly children: ReactNode
}

/**
 * The default app frame: a sidebar with the app's brand, its nav and the user menu, beside the
 * page. Inside a built-in section the sidebar shows that section's pages. Sidebar props keep the
 * `@sixb/ui` names. Every part is exported for shells built by hand.
 */
export function AppShell({
  nav,
  brand,
  header,
  footer,
  userMenu,
  agent,
  variant = "inset",
  collapsible = "icon",
  side = "left",
  defaultOpen,
  children,
}: AppShellProps) {
  return (
    <AppShellProvider defaultOpen={defaultOpen}>
      <AppShellFrame
        nav={nav}
        brand={brand}
        header={header}
        footer={footer}
        userMenu={userMenu}
        agent={agent}
        variant={variant}
        collapsible={collapsible}
        side={side}
      >
        {children}
      </AppShellFrame>
    </AppShellProvider>
  )
}

// Inside the provider, to know whether this is a phone. With nav as data a phone gets the native
// shell: a top bar, a tab bar of the `tab` places and a More sheet in place of the sidebar.
function AppShellFrame({
  nav,
  brand,
  header,
  footer,
  userMenu,
  agent,
  variant,
  collapsible,
  side,
  children,
}: Omit<AppShellProps, "defaultOpen">) {
  const { isMobile } = useSidebar()
  const appMessages = useAppMessages()
  const places = isNavData(nav) ? withPhoneTabs(nav) : null
  const phone = isMobile && places !== null

  return (
    <>
      {phone ? (
        <PhoneMoreSheet nav={places.nav} />
      ) : (
        <Sidebar variant={variant} collapsible={collapsible} side={side}>
          <SidebarHeader>
            {brand === undefined ? <Brand /> : brand}
            {header === undefined ? <SearchCommand pages={isNavData(nav) ? nav : []} /> : header}
          </SidebarHeader>
          <SidebarContent>
            <SectionNav fallback={isNavData(nav) ? <NavItems items={nav} /> : nav} />
            {collapsible === "none" ? null : <CollapseToggle />}
          </SidebarContent>
          <SidebarFooter>
            {footer}
            {userMenu === undefined ? <UserMenu /> : userMenu}
          </SidebarFooter>
          {collapsible === "none" ? null : (
            // Beside an inset page the rail's hover line lands in the gap, so it stays invisible there.
            <SidebarRail className={variant === "inset" ? "after:hidden" : undefined} />
          )}
        </Sidebar>
      )}
      <SidebarInset className={cn("min-h-0 overflow-hidden", phone && "phone-shell")}>
        {phone ? (
          <PhoneTopBar
            trailing={
              <>
                <SearchCommand pages={places.nav} placement="toolbar" />
                {agent === undefined ? (
                  <button
                    type="button"
                    onClick={() => setAgentSurfaceMode("dock")}
                    aria-label={appMessages.agent.open}
                    className="phone-bar-action"
                  >
                    <MessageSquareText className="size-5" strokeWidth={1.9} aria-hidden="true" />
                  </button>
                ) : null}
              </>
            }
          />
        ) : (
          // Phones without nav data get the sidebar as a sheet; this is the way to open it.
          <div className="flex h-12 shrink-0 items-center border-b border-border px-3 md:hidden">
            <SidebarTrigger className="-ml-1" />
          </div>
        )}
        <div className="relative flex min-h-0 flex-1">
          {/* The page's scroll container: screen motion, scroll restoration and pull to refresh
              work on it on a phone. */}
          <div data-app-scroll className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {children}
          </div>
          {agent === undefined ? <AgentDock /> : agent}
        </div>
        {phone ? <PhoneTabBar items={places.tabs} /> : null}
      </SidebarInset>
    </>
  )
}

/**
 * The places a phone's tab bar holds: those marked `tab`, else the first four with an icon. Each
 * comes back marked, so the More sheet leaves them out.
 */
function withPhoneTabs(nav: readonly NavEntry[]): {
  readonly nav: readonly NavEntry[]
  readonly tabs: readonly NavItem[]
} {
  const items = nav.flatMap((entry): readonly NavItem[] =>
    "group" in entry ? entry.items : [entry]
  )
  const marked = items.filter((item) => item.tab)
  const tabs = (marked.length ? marked : items.filter((item) => item.icon)).slice(0, 4)
  const tab = (item: NavItem): NavItem => (tabs.includes(item) ? { ...item, tab: true } : item)
  return {
    tabs,
    nav: nav.map((entry) =>
      "group" in entry ? { ...entry, items: entry.items.map(tab) } : tab(entry)
    ),
  }
}

// On phones the sidebar is a sheet that closes on its own, so it gets no collapse control.
function CollapseToggle() {
  const { isMobile } = useSidebar()
  if (isMobile) return null
  return (
    <SidebarGroup className="mt-auto">
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarCollapseToggle />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function isNavData(nav: AppShellProps["nav"]): nav is readonly NavEntry[] {
  return Array.isArray(nav)
}
