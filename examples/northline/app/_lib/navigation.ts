import {
  CalendarClock,
  ClipboardList,
  FileText,
  Gauge,
  Handshake,
  type LucideIcon,
  Network,
  Sun,
  UsersRound,
} from "lucide-react"

export interface Place {
  readonly href: string
  readonly label: string
  readonly icon: LucideIcon
  readonly section: "operations" | "business"
  /** One of the four places the phone's tab bar holds; the others are under More. */
  readonly tab?: boolean
  /** The live count the sidebar shows beside it. */
  readonly count?: "openCases" | "quotesWithCustomer"
}

/**
 * Northline's places, in order. The sidebar, the phone's tab bar and More sheet, the phone's
 * titles and the assistant's page context all read this one list.
 */
export const places: readonly Place[] = [
  { href: "/", label: "Home", icon: Sun, section: "operations", tab: true },
  {
    href: "/service-cases",
    label: "Service cases",
    icon: ClipboardList,
    section: "operations",
    tab: true,
    count: "openCases",
  },
  { href: "/dispatch", label: "Dispatch", icon: CalendarClock, section: "operations", tab: true },
  { href: "/equipment", label: "Equipment", icon: Gauge, section: "operations", tab: true },
  { href: "/technicians", label: "Technicians", icon: UsersRound, section: "operations" },
  {
    href: "/quotes",
    label: "Quotes",
    icon: FileText,
    section: "business",
    count: "quotesWithCustomer",
  },
  { href: "/contracts", label: "Contracts", icon: Handshake, section: "business" },
  { href: "/customers", label: "Customers", icon: Network, section: "business" },
]

/** The place a path belongs to: its own, or the list a record sits under. */
export function placeFor(pathname: string): Place | undefined {
  return places.find((place) =>
    place.href === "/"
      ? pathname === "/"
      : pathname === place.href || pathname.startsWith(`${place.href}/`)
  )
}
