import type { UserRef } from "@sixb/core"
import { UserRound } from "lucide-react"

/**
 * A `userRef` value. The value carries only the user id: Atlas shows it as is
 * until reads resolve user profiles.
 */
export function UserRefChip({ userRef }: { userRef: UserRef }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-0.5 text-xs font-medium text-foreground">
        <UserRound className="h-3 w-3 text-sky-600 dark:text-sky-400" />
        user
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground" title={userRef.id}>
        {userRef.id}
      </span>
    </span>
  )
}

/** The `userRef` form used on debugging surfaces: nothing truncated. */
export function DebugUserRef({ userRef }: { userRef: UserRef }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
      <UserRound className="size-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
      <span className="font-medium text-foreground">user</span>
      <span aria-hidden="true" className="text-muted-foreground/60">
        ·
      </span>
      <span className="min-w-[8rem] flex-1 break-all font-mono text-muted-foreground">
        {userRef.id}
      </span>
    </span>
  )
}
