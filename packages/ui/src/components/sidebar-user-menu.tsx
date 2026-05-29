import {
  Check,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  ExternalLink,
  LaptopMinimal,
  LogOut,
  MoonStar,
  Settings2,
  SunMedium,
} from "lucide-react"
import { useTheme } from "../hooks/useTheme"
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

const themes = [
  { value: "light", label: "Light", Icon: SunMedium },
  { value: "dark", label: "Dark", Icon: MoonStar },
  { value: "system", label: "System", Icon: LaptopMinimal },
] as const

export interface SidebarUser {
  readonly name: string
  readonly email?: string
  readonly avatarUrl?: string
}

interface SidebarUserMenuProps {
  /** The signed-in user, or null when auth is disabled or unauthenticated. */
  user: SidebarUser | null
  /** Optional link to the API reference, surfaced inside the menu. */
  apiHref?: string
  /** Sign-out handler. Only shown when a user and handler are both present. */
  onSignOut?: () => void
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
export function SidebarUserMenu({ user, apiHref, onSignOut }: SidebarUserMenuProps) {
  const { theme, setTheme } = useTheme()
  const { isMobile } = useSidebar()

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
                tooltip="Preferences"
                className="text-sidebar-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <Settings2 />
                <span>Preferences</span>
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

            {themes.map((option) => {
              const Icon = option.Icon
              const selected = option.value === theme
              return (
                <DropdownMenuItem key={option.value} onClick={() => setTheme(option.value)}>
                  <Icon />
                  <span className="flex-1">{option.label}</span>
                  {selected ? <Check className="text-muted-foreground" /> : null}
                </DropdownMenuItem>
              )
            })}

            {apiHref ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <a href={apiHref} target="_blank" rel="noopener noreferrer">
                    <ExternalLink />
                    <span>API reference</span>
                  </a>
                </DropdownMenuItem>
              </>
            ) : null}

            {user && onSignOut ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onSignOut}>
                  <LogOut />
                  <span>Log out</span>
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
