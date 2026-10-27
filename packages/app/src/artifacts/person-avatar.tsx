import { Avatar, AvatarFallback } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"

const SIZES = {
  xs: { root: "size-5", text: "text-[9px]" },
  sm: { root: "size-6", text: "text-[9px]" },
  md: { root: "size-8", text: "text-xs" },
} as const

/** Someone's initials in a quiet circle, the one avatar the conversation uses everywhere. */
export function PersonAvatar({
  name,
  size = "sm",
  className,
}: {
  readonly name: string
  readonly size?: keyof typeof SIZES
  readonly className?: string
}) {
  return (
    <Avatar aria-hidden className={cn(SIZES[size].root, className)}>
      <AvatarFallback
        className={cn(
          "bg-muted-foreground/15 font-medium tracking-tight text-foreground/75",
          SIZES[size].text
        )}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  )
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase()

  return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase()
}
