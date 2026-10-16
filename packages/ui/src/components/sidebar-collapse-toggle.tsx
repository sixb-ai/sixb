import { ChevronsLeft, ChevronsRight } from "lucide-react"
import { useUiMessages } from "../lib/i18n/ui"
import { SidebarMenuButton, useSidebar } from "./ui/sidebar"

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
