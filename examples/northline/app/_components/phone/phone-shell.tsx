import { Sidebar, useSidebar } from "@sixb/ui/components"
import type { ComponentProps } from "react"
import { NavigationMotion } from "./navigation-motion"
import { PhoneMoreSheet } from "./phone-more-sheet"
import { ScrollRestoration } from "./scroll-restoration"
import { SheetGestures } from "./sheet-gestures"
import { SwipeBack } from "./swipe-back"
import { ViewportController } from "./viewport-controller"

/**
 * The viewport, keyboard, scroll and gesture handling that makes the app behave like an installed
 * one on a phone. Each part renders nothing and checks for itself whether it applies, so this sits
 * once at the root and stays mounted across every page, the full-screen ones included.
 */
export function PhoneBehaviors() {
  return (
    <>
      <ViewportController />
      <ScrollRestoration />
      <NavigationMotion />
      <SheetGestures />
      <SwipeBack />
    </>
  )
}

/**
 * The sidebar from 768 px up. On phones the tab bar's More sheet takes its place, and anything
 * that opens the sidebar, the tab bar's More button and ⌘B included, opens the sheet instead.
 */
export function SidebarOrMoreSheet(props: ComponentProps<typeof Sidebar>) {
  const { isMobile, openMobile, setOpenMobile } = useSidebar()
  if (isMobile) return <PhoneMoreSheet open={openMobile} onOpenChange={setOpenMobile} />
  return <Sidebar {...props} />
}
