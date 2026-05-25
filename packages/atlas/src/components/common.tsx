import { Button } from "@pario/ui/components"
import { cn } from "@pario/ui/lib/utils"
import { ChevronLeft, Loader2 } from "lucide-react"
import type { ReactNode } from "react"
import { useNavigate } from "react-router-dom"

type AvatarSize = "xs" | "sm" | "md" | "lg"

const avatarSizeClasses: Record<AvatarSize, string> = {
  xs: "size-5 rounded-md text-[10px]",
  sm: "size-7 rounded-md text-xs",
  md: "size-10 rounded-lg text-base",
  lg: "size-12 rounded-lg text-lg",
}

export function LetterAvatar({ label, size = "xs" }: { label: string; size?: AvatarSize }) {
  const letter = label.trim()[0]?.toUpperCase() ?? "?"
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center border border-border bg-muted font-mono font-medium text-muted-foreground",
        avatarSizeClasses[size]
      )}
    >
      {letter}
    </span>
  )
}

export function Section({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children?: ReactNode
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        {count != null ? (
          <span className="text-[11px] tabular-nums text-muted-foreground">· {count}</span>
        ) : null}
      </div>
      {children}
    </section>
  )
}

export function BackNav({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate()
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => navigate(to)}
      className="-ml-2 self-start text-muted-foreground hover:text-foreground"
    >
      <ChevronLeft />
      {label}
    </Button>
  )
}

export function LoadingState({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  )
}
