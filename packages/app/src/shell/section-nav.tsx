import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@sixb/ui/components"
import { ChevronLeft } from "lucide-react"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { useAppMessages } from "../locale"
import { usePageCounts } from "../sections/counts"
import { useCurrentSection, useRegisterSectionNav } from "../sections/sections"
import { type NavEntry, type NavItem, NavItems } from "./nav-items"

export interface SectionNavProps {
  /** What the sidebar shows outside a section, usually the app's nav. */
  readonly fallback?: ReactNode
  /** Where the back link leads. */
  readonly backHref?: string
}

/**
 * Inside a built-in section, the section's pages with a link back; anywhere else, `fallback`.
 * While it is in the sidebar, section pages leave out their own tabs.
 */
export function SectionNav({ fallback = null, backHref = "/" }: SectionNavProps) {
  useRegisterSectionNav()
  const messages = useAppMessages().sections
  const section = useCurrentSection()
  const counts = usePageCounts(section?.id)

  if (!section) return fallback

  const counted = (item: NavItem): NavItem =>
    counts[item.href] === undefined ? item : { ...item, badge: counts[item.href] }
  const pages = section.pages.map(
    (entry): NavEntry =>
      "group" in entry ? { ...entry, items: entry.items.map(counted) } : counted(entry)
  )

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip={messages.back}>
                <Link to={backHref}>
                  <ChevronLeft />
                  <span className="font-medium">{section.label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      <NavItems items={pages} />
    </>
  )
}
