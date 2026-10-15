import { Check, LaptopMinimal, MoonStar, SunMedium } from "lucide-react"
import { useOptionalTheme, useTheme } from "../hooks/useTheme"
import { useUiMessages } from "../lib/i18n/ui"
import { cn } from "../lib/utils"
import { Button } from "./ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu"

const themes = [
  { value: "light", Icon: SunMedium },
  { value: "dark", Icon: MoonStar },
  { value: "system", Icon: LaptopMinimal },
] as const

interface ThemeSwitcherProps {
  className?: string
}

/** A dropdown button for a toolbar: the current theme's icon, the three themes in its menu. */
export function ThemeSwitcher({ className }: ThemeSwitcherProps) {
  const { theme, setTheme } = useTheme()
  const messages = useUiMessages().theme
  const active = themes.find((t) => t.value === theme) ?? themes[2]
  const ActiveIcon = active.Icon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className={cn(className)}
          aria-label={messages.label}
        >
          <ActiveIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        {themes.map((option) => {
          const Icon = option.Icon
          const selected = option.value === theme
          return (
            <DropdownMenuItem key={option.value} onClick={() => setTheme(option.value)}>
              <Icon />
              <span className="flex-1">{messages[option.value]}</span>
              {selected ? <Check className="text-muted-foreground" /> : null}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface ThemePickerProps {
  /** Name each theme beside its icon, for a settings page. Without it the icons stand alone. */
  labels?: boolean
  /**
   * Whether the options take keyboard focus. Inside a menu, whose items own the focus, turn it off
   * and switch themes from the item instead.
   */
  focusable?: boolean
  className?: string
}

/**
 * The three themes side by side, the current one raised. Renders nothing outside a ThemeProvider.
 */
export function ThemePicker({ labels = false, focusable = true, className }: ThemePickerProps) {
  const controls = useOptionalTheme()
  const messages = useUiMessages().theme
  if (!controls) return null

  return (
    <div
      role="radiogroup"
      aria-label={messages.label}
      className={cn(
        "inline-flex items-center bg-muted/70 ring-1 ring-border/70",
        labels ? "gap-0.5 rounded-lg p-1" : "rounded-full p-0.5",
        className
      )}
    >
      {themes.map((option) => {
        const Icon = option.Icon
        const selected = option.value === controls.theme
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={labels ? undefined : messages[option.value]}
            title={labels ? undefined : messages[option.value]}
            tabIndex={focusable ? undefined : -1}
            onClick={() => controls.setTheme(option.value)}
            className={cn(
              "flex items-center justify-center text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
              labels
                ? "h-8 gap-2 rounded-md px-3 text-sm font-medium [&_svg]:size-4"
                : "size-6 rounded-full [&_svg]:size-3.5",
              selected && "bg-background text-foreground ring-1 ring-border"
            )}
          >
            <Icon />
            {labels ? messages[option.value] : null}
          </button>
        )
      })}
    </div>
  )
}

/** The theme after `theme` in the picker's order, or before it with `step` -1, wrapping around. */
export function nextTheme(theme: string, step: 1 | -1): (typeof themes)[number]["value"] {
  const index = themes.findIndex((option) => option.value === theme)
  return themes[(index + step + themes.length) % themes.length].value
}
