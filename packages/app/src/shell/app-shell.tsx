import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@sixb/ui/components"
import { ThemeProvider } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import type { CSSProperties, ReactNode } from "react"
import { Brand } from "./brand"
import { type NavEntry, NavItems } from "./nav-items"
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
  /** Shown below the brand. */
  readonly header?: ReactNode
  /** Shown above the user menu. */
  readonly footer?: ReactNode
  /** Replaces the user menu; `null` removes it. */
  readonly userMenu?: ReactNode
  readonly variant?: "sidebar" | "floating" | "inset"
  readonly collapsible?: "offcanvas" | "icon" | "none"
  readonly side?: "left" | "right"
  readonly defaultOpen?: boolean
  readonly children: ReactNode
}

/**
 * The default app frame: a sidebar with the app's brand, its nav and the user menu, beside the
 * page. Sidebar props keep the `@sixb/ui` names. Every part is exported for shells built by hand.
 */
export function AppShell({
  nav,
  brand,
  header,
  footer,
  userMenu,
  variant = "inset",
  collapsible = "offcanvas",
  side = "left",
  defaultOpen,
  children,
}: AppShellProps) {
  return (
    <AppShellProvider defaultOpen={defaultOpen}>
      <Sidebar variant={variant} collapsible={collapsible} side={side}>
        <SidebarHeader>
          {brand === undefined ? <Brand /> : brand}
          {header}
        </SidebarHeader>
        <SidebarContent>{isNavData(nav) ? <NavItems items={nav} /> : nav}</SidebarContent>
        <SidebarFooter>
          {footer}
          {userMenu === undefined ? <UserMenu /> : userMenu}
        </SidebarFooter>
        {collapsible === "none" ? null : <SidebarRail />}
      </Sidebar>
      <SidebarInset className="min-h-0 overflow-hidden">
        {/* Phones get the sidebar as a sheet; this is the way to open it. */}
        <div className="flex h-12 shrink-0 items-center border-b border-border px-3 md:hidden">
          <SidebarTrigger className="-ml-1" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </SidebarInset>
    </AppShellProvider>
  )
}

function isNavData(nav: AppShellProps["nav"]): nav is readonly NavEntry[] {
  return Array.isArray(nav)
}
