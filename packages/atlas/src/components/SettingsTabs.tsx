import { cn } from "@sixb/ui/lib/utils"
import { Link, useLocation } from "react-router-dom"

// Workspace-scoped pages first, personal ones last; page copy makes the
// scope of each explicit.
const TABS = [
  { label: "Members", path: "/settings/members" },
  { label: "Service accounts", path: "/settings/service-accounts" },
  { label: "Tokens", path: "/settings/tokens" },
  { label: "Sessions", path: "/settings/sessions" },
] as const

export function SettingsTabs() {
  const { pathname } = useLocation()

  return (
    <nav className="flex max-w-full w-fit gap-1 overflow-x-auto rounded-lg border border-border/60 bg-card p-1">
      {TABS.map((tab) => {
        const active = pathname === tab.path
        return (
          <Link
            key={tab.path}
            to={tab.path}
            className={cn(
              "inline-flex h-8 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors",
              active
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
