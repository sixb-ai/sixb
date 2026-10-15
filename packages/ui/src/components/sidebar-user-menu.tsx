import {
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  ExternalLink,
  LogOut,
  Settings2,
  SunMoon,
} from "lucide-react"
import type { ComponentType, ReactNode } from "react"
import { useOptionalTheme } from "../hooks/useTheme"
import { useUiMessages } from "../lib/i18n/ui"
import { nextTheme, ThemePicker } from "./theme-switcher"
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "./ui/sidebar"

export interface SidebarUser {
  readonly name: string
  readonly email?: string
  readonly avatarUrl?: string
}

interface SidebarUserMenuProps {
  /** The signed-in user, or null when auth is disabled or unauthenticated. */
  user: SidebarUser | null
  /** The button's label and icon while nobody is signed in, in place of Preferences. */
  signedOut?: {
    readonly label: string
    readonly icon: ComponentType<{ readonly className?: string }>
  }
  /** Optional link to the API reference, surfaced inside the menu. */
  apiHref?: string
  /** Sign-out handler. Only shown when a user and handler are both present. */
  onSignOut?: () => void
  /** Extra menu items, shown below the user and above theme switching. */
  children?: ReactNode
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
}

/**
 * Standardized sidebar footer menu: signed-in identity, theme switching, an API
 * reference link, and sign-out, all folded into a single dropdown off the avatar
 * row. When no user is present it degrades to a preferences menu (theme + API).
 */
export function SidebarUserMenu({
  user,
  signedOut,
  apiHref,
  onSignOut,
  children,
}: SidebarUserMenuProps) {
  // Theme switching appears only where the app provides a theme.
  const themeControls = useOptionalTheme()
  const { isMobile } = useSidebar()
  const messages = useUiMessages()
  const SignedOutIcon = signedOut?.icon ?? Settings2
  const signedOutLabel = signedOut?.label ?? messages.sidebar.preferences

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {user ? (
              <SidebarMenuButton
                size="lg"
                tooltip={user.name}
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <Avatar className="h-8 w-8 rounded-md">
                  {user.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={user.name} /> : null}
                  <AvatarFallback className="rounded-md text-xs">
                    {initials(user.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">{user.name}</span>
                  {user.email ? (
                    <span className="truncate text-xs text-sidebar-foreground/70">
                      {user.email}
                    </span>
                  ) : null}
                </div>
                <ChevronsUpDown className="ml-auto size-4" />
              </SidebarMenuButton>
            ) : (
              <SidebarMenuButton
                tooltip={signedOutLabel}
                className="text-sidebar-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <SignedOutIcon />
                <span>{signedOutLabel}</span>
              </SidebarMenuButton>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side={isMobile ? "bottom" : "top"}
            align="end"
            sideOffset={4}
            className="min-w-56 rounded-lg"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            {user ? (
              <>
                <DropdownMenuLabel className="p-0 font-normal">
                  <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                    <Avatar className="h-8 w-8 rounded-md">
                      {user.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={user.name} /> : null}
                      <AvatarFallback className="rounded-md text-xs">
                        {initials(user.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-semibold">{user.name}</span>
                      {user.email ? (
                        <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                      ) : null}
                    </div>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
              </>
            ) : null}

            {children ? (
              <>
                {children}
                {themeControls ? <DropdownMenuSeparator /> : null}
              </>
            ) : null}

            {themeControls ? (
              // One row: a click on an option picks it, and with the row focused the arrow keys
              // step through the themes. Choosing keeps the menu open, so the change shows.
              <DropdownMenuItem
                aria-keyshortcuts="ArrowLeft ArrowRight"
                onSelect={(event) => event.preventDefault()}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
                  event.preventDefault()
                  themeControls.setTheme(
                    nextTheme(themeControls.theme, event.key === "ArrowRight" ? 1 : -1)
                  )
                }}
              >
                <SunMoon />
                <span className="flex-1">{messages.theme.label}</span>
                <ThemePicker focusable={false} />
              </DropdownMenuItem>
            ) : null}

            {apiHref ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <a href={apiHref} target="_blank" rel="noopener noreferrer">
                    <ExternalLink />
                    <span>{messages.sidebar.apiReference}</span>
                  </a>
                </DropdownMenuItem>
              </>
            ) : null}

            {user && onSignOut ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onSignOut}>
                  <LogOut />
                  <span>{messages.sidebar.logOut}</span>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

/** Shared collapse/expand toggle for the sidebar rail. */
export function SidebarCollapseToggle() {
  const { state, toggleSidebar } = useSidebar()
  const messages = useUiMessages()
  const collapsed = state === "collapsed"
  const label = collapsed ? messages.sidebar.expand : messages.sidebar.collapse
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
