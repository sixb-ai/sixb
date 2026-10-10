import { Check, LaptopMinimal, MoonStar, SunMedium } from "lucide-react"
import { useTheme } from "../hooks/useTheme"
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
