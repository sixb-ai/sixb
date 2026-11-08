import { Sidebar, useSidebar } from "@sixb/ui/components"
import type { ComponentProps } from "react"
import { PhoneMoreSheet } from "./phone-more-sheet"

/**
 * The sidebar from 768 px up. On phones the tab bar's More sheet takes its place, and anything
 * that opens the sidebar, the tab bar's More button and ⌘B included, opens the sheet instead.
 */
export function SidebarOrMoreSheet(props: ComponentProps<typeof Sidebar>) {
  const { isMobile, openMobile, setOpenMobile } = useSidebar()
  if (isMobile) return <PhoneMoreSheet open={openMobile} onOpenChange={setOpenMobile} />
  return <Sidebar {...props} />
}
