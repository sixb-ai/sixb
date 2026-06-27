import { cn } from "@sixb/ui/lib/utils"

/** A clean circular monogram for an agent — initials over a neutral fill, no robot iconography. */
export function AgentAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 select-none items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground",
        className
      )}
    >
      {initials(name)}
    </span>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}
