import { DropdownMenuItem, SidebarUserMenu } from "@sixb/ui/components"
import type { ComponentType, ReactNode } from "react"
import { useSections } from "../sections/sections"
import { useCurrentUser, useSignOut } from "../session"

export interface UserMenuProps {
  /** Extra items, such as `<UserMenu.Item>`, shown above sign-out. */
  readonly children?: ReactNode
}

export interface UserMenuItemProps {
  readonly href?: string
  readonly icon?: ComponentType<{ readonly className?: string }>
  readonly onSelect?: () => void
  readonly children: ReactNode
}

/**
 * The signed-in person, the built-in sections they may open, theme switching and sign-out, at the
 * foot of any sidebar. A shell with only this still reaches every section.
 */
function UserMenuRoot({ children }: UserMenuProps) {
  const user = useCurrentUser()
  const signOut = useSignOut()
  const sections = useSections()

  return (
    <SidebarUserMenu
      user={
        user
          ? {
              name: user.displayName ?? user.email,
              email: user.displayName ? user.email : undefined,
              avatarUrl: user.avatarUrl,
            }
          : null
      }
      onSignOut={() => {
        signOut().catch((error: unknown) => {
          console.error("[SixbApp] Could not sign out:", error)
        })
      }}
    >
      {sections.length > 0 || children ? (
        <>
          {sections.map((section) => (
            <UserMenuItem key={section.id} href={section.href} icon={section.icon}>
              {section.label}
            </UserMenuItem>
          ))}
          {children}
        </>
      ) : null}
    </SidebarUserMenu>
  )
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
