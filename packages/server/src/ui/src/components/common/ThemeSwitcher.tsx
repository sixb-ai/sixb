import { Popover } from "radix-ui"
import { useState } from "react"
import { useTheme } from "../../hooks/useTheme"
import { cn } from "../../lib/utils"

type Theme = "light" | "dark" | "system"

const themes: { value: Theme; icon: React.ReactNode; label: string }[] = [
  {
    value: "light",
    label: "Light",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
        />
      </svg>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
        />
      </svg>
    ),
  },
  {
    value: "system",
    label: "System",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
        />
      </svg>
    ),
  },
]

interface ThemeSwitcherProps {
  compact?: boolean
}

export function ThemeSwitcher({ compact }: ThemeSwitcherProps) {
  const { theme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)

  const activeTheme = themes.find((t) => t.value === theme) ?? themes[0]

  if (compact) {
    return (
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="rounded-lg border border-border/30 bg-accent/30 p-1.5 text-foreground transition-colors hover:bg-accent/50"
            title="Theme"
          >
            {activeTheme.icon}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={8}
            className="z-50 rounded-xl border border-border bg-card shadow-xl overflow-hidden animate-in fade-in-0 zoom-in-95"
          >
            <div className="py-1">
              {themes.map((t) => (
                <button
                  type="button"
                  key={t.value}
                  onClick={() => {
                    setTheme(t.value)
                    setOpen(false)
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors",
                    theme === t.value
                      ? "bg-muted/50 text-foreground"
                      : "text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                  )}
                >
                  {t.icon}
                  <span>{t.label}</span>
                  {theme === t.value && (
                    <svg
                      className="ml-auto h-4 w-4 shrink-0 text-foreground"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    )
  }

  return (
    <div className="flex items-center gap-1 p-1 rounded-lg bg-accent/30 border border-border/30">
      {themes.map((t) => (
        <button
          key={t.value}
          onClick={() => setTheme(t.value)}
          title={t.label}
          className={cn(
            "p-1.5 rounded-md transition-all",
            theme === t.value
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
          )}
        >
          {t.icon}
        </button>
      ))}
    </div>
  )
}
