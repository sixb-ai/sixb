import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  nextTheme,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  ThemePicker,
  useSidebar,
} from "@sixb/ui/components"
import { useOptionalTheme } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronsUpDown, CircleUserRound, Layers, LogOut, SunMoon } from "lucide-react"
import type { ComponentType, ReactNode } from "react"
import { useAppMessages } from "../locale"
import { ARTIFACTS_HREF } from "../pages/routes"
import { useSections } from "../sections/sections"
import { type CurrentUser, useCurrentUser, useSignOut } from "../session"

export interface UserMenuProps {
  /** Extra items, such as `<UserMenu.Item>`, shown below the built-in sections. */
  readonly children?: ReactNode
}

export interface UserMenuItemProps {
  readonly href?: string
  readonly icon?: ComponentType<{ readonly className?: string }>
  readonly onSelect?: () => void
  readonly children: ReactNode
}

/**
 * The signed-in person, the built-in sections they may open, such as Data and Settings, theme
 * switching and sign-out, at the foot of any sidebar. With sign-in off it is the way into the
 * sections.
 */
function UserMenuRoot({ children }: UserMenuProps) {
  const user = useCurrentUser()
  const signOut = useSignOut()
  const sections = useSections()
  const appMessages = useAppMessages()
  const messages = appMessages.userMenu
  // Theme switching appears only where the app provides a theme.
  const themeControls = useOptionalTheme()
  const { isMobile } = useSidebar()
  const items = (
    <>
      <UserMenuItem href={ARTIFACTS_HREF} icon={Layers}>
        {appMessages.artifacts}
      </UserMenuItem>
      {sections.map((section) => (
        <UserMenuItem key={section.id} href={section.href} icon={section.icon}>
          {section.label}
        </UserMenuItem>
      ))}
      {children}
    </>
  )

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {user ? (
              <SidebarMenuButton
                size="lg"
                tooltip={displayName(user)}
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <Identity user={user} emailClassName="text-sidebar-foreground/70" />
                <ChevronsUpDown className="ml-auto size-4" />
              </SidebarMenuButton>
            ) : (
              <SidebarMenuButton
                tooltip={messages.signInOff}
                className="text-sidebar-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <CircleUserRound />
                <span>{messages.signInOff}</span>
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
                    <Identity user={user} emailClassName="text-muted-foreground" />
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
              </>
            ) : null}

            {items ? (
              <>
                {items}
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
                <span className="flex-1">{messages.theme}</span>
                <ThemePicker focusable={false} />
              </DropdownMenuItem>
            ) : null}

            {user ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    signOut().catch((error: unknown) => {
                      console.error("[SixbApp] Could not sign out:", error)
                    })
                  }}
                >
                  <LogOut />
                  <span>{messages.signOut}</span>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function displayName(user: CurrentUser): string {
  return user.displayName ?? user.email
}

/** The person's avatar, name and, when the name is not the address, their email. */
function Identity({
  user,
  emailClassName,
}: {
  readonly user: CurrentUser
  readonly emailClassName: string
}) {
  const name = displayName(user)
  return (
    <>
      <Avatar className="h-8 w-8 rounded-md">
        {user.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={name} /> : null}
        <AvatarFallback className="rounded-md text-xs">{initials(name)}</AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-semibold">{name}</span>
        {user.displayName ? (
          <span className={cn("truncate text-xs", emailClassName)}>{user.email}</span>
        ) : null}
      </div>
    </>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
}

function UserMenuItem({ href, icon: Icon, onSelect, children }: UserMenuItemProps) {
  const content = (
    <>
      {Icon ? <Icon /> : null}
      <span>{children}</span>
    </>
  )
  return href ? (
    <DropdownMenuItem asChild onSelect={onSelect}>
      <a href={href}>{content}</a>
    </DropdownMenuItem>
  ) : (
    <DropdownMenuItem onSelect={onSelect}>{content}</DropdownMenuItem>
  )
}

export const UserMenu = Object.assign(UserMenuRoot, { Item: UserMenuItem })
