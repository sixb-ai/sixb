import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@sixb/ui/components"
import { ChevronLeft } from "lucide-react"
import type { ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { useAppMessages } from "../locale"
import { sectionContains, useRegisterSectionNav, useSections } from "../sections/sections"
import { NavItems } from "./nav-items"

export interface SectionNavProps {
  /** What the sidebar shows outside a section, usually the app's own nav. */
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
  const { pathname } = useLocation()
  const messages = useAppMessages().sections
  const section = useSections().find((candidate) => sectionContains(candidate, pathname))

  if (!section) return fallback

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
      <NavItems items={section.pages} />
    </>
  )
}
