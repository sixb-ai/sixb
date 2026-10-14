import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@sixb/ui/components"
import type { ComponentType, ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"

/** One link in the sidebar. */
export interface NavItem {
  readonly label: string
  readonly href: string
  readonly icon?: ComponentType<{ readonly className?: string }>
  /** Shown at the end of the row, such as a count. */
  readonly badge?: ReactNode
  /** Links nested under this one. */
  readonly items?: readonly NavItem[]
}

/** Links under a heading. */
export interface NavGroup {
  readonly group: string
  readonly items: readonly NavItem[]
}

export type NavEntry = NavItem | NavGroup

export interface NavItemsProps {
  readonly items: readonly NavEntry[]
}

/**
 * Renders nav data with the `@sixb/ui` sidebar primitives. Links before the first group share an
 * unlabeled group, and the link for the current page is marked active.
 */
export function NavItems({ items }: NavItemsProps) {
  const { pathname } = useLocation()

  return (
    <>
      {groupEntries(items).map((group, index) => (
        <SidebarGroup key={group.label ?? `group-${index}`}>
          {group.label ? <SidebarGroupLabel>{group.label}</SidebarGroupLabel> : null}
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={isCurrent(pathname, item.href)}
                    tooltip={item.label}
                  >
                    {navLink(
                      item.href,
                      <>
                        {item.icon ? <item.icon /> : null}
                        <span>{item.label}</span>
                      </>
                    )}
                  </SidebarMenuButton>
                  {item.badge !== undefined ? (
                    <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>
                  ) : null}
                  {item.items?.length ? (
                    <SidebarMenuSub>
                      {item.items.map((child) => (
                        <SidebarMenuSubItem key={child.href}>
                          <SidebarMenuSubButton asChild isActive={isCurrent(pathname, child.href)}>
                            {navLink(child.href, <span>{child.label}</span>)}
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  ) : null}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  )
}

// An element, not a component: the sidebar button passes its props and ref to its direct child.
function navLink(href: string, children: ReactNode) {
  return isExternal(href) ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <Link to={href}>{children}</Link>
  )
}

function groupEntries(
  entries: readonly NavEntry[]
): { readonly label?: string; readonly items: readonly NavItem[] }[] {
  const groups: { label?: string; items: NavItem[] }[] = []
  for (const entry of entries) {
    if ("group" in entry) {
      groups.push({ label: entry.group, items: [...entry.items] })
      continue
    }
    const last = groups.at(-1)
    if (last && last.label === undefined) last.items.push(entry)
    else groups.push({ items: [entry] })
  }
  return groups
}

function isCurrent(pathname: string, href: string): boolean {
  if (isExternal(href)) return false
  if (href === "/") return pathname === "/"
  const base = href.replace(/\/+$/, "")
  return pathname === base || pathname.startsWith(`${base}/`)
}

function isExternal(href: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")
}
