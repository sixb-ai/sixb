import { cn } from "@sixb/ui/lib/utils"
import { Link, useLocation } from "react-router-dom"

const TABS = [
  { label: "Invitations", path: "/settings/invitations" },
  { label: "Sessions", path: "/settings/sessions" },
] as const

export function SettingsTabs() {
  const { pathname } = useLocation()

  return (
    <nav className="flex w-fit gap-1 rounded-lg border border-border/60 bg-card p-1">
      {TABS.map((tab) => {
        const active = pathname === tab.path
        return (
          <Link
            key={tab.path}
            to={tab.path}
            className={cn(
              "inline-flex h-8 items-center rounded-md px-3 text-sm font-medium transition-colors",
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
