import { cn } from "@sixb/ui/lib/utils"
import { useArtifactMessages } from "./messages"

/**
 * Beside a name a shared link's visitor typed: they have no account, so the name is only theirs to
 * say. Everyone sees it, the guest included, so nobody takes them for a member of the same name.
 */
export function GuestBadge({ className }: { readonly className?: string }) {
  const messages = useArtifactMessages().canvas.comments
  return (
    <span
      title={messages.guestHint}
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-full bg-muted px-1.5 text-[10.5px] leading-none font-medium tracking-[0.01em] text-muted-foreground ring-1 ring-border/70 ring-inset",
        className
      )}
    >
      {messages.guest}
    </span>
  )
}
