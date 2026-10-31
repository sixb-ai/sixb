import { useUser } from "@sixb/client/hooks"
import { Avatar, AvatarFallback, AvatarImage } from "@sixb/ui/components"
import { KeyRound } from "lucide-react"
import { initials } from "../../../artifacts/person-avatar"
import { useLineageMessages } from "./messages"
import type { Requester } from "./model"

// A renamed member shows the new name within this delay, as their chips elsewhere do.
const PROFILE_STALE_MS = 5 * 60_000

/**
 * The member an edit ran for, from the directory the member picker reads. `null` for a service
 * account, and for a member the reader may not look up.
 */
function useRequesterProfile(requester: Requester | undefined) {
  const member = requester?.type === "user"
  return (
    useUser(member ? requester.id : "", {
      enabled: member,
      retry: false,
      staleTime: PROFILE_STALE_MS,
    }).data ?? null
  )
}

/** The requester's name for a sentence, such as "The source is newer than Alice's edit". */
export function useRequesterName(requester: Requester | undefined): string | null {
  const profile = useRequesterProfile(requester)
  return profile ? (profile.displayName ?? profile.email) : null
}

/** Who an edit ran for: the member's avatar and name, or what kind of principal it was. */
export function RequesterLine({ requester }: { readonly requester: Requester }) {
  const messages = useLineageMessages().edit
  const profile = useRequesterProfile(requester)

  if (requester.type === "serviceAccount") {
    return (
      <span className="inline-flex min-w-0 items-center gap-2" title={requester.id}>
        <span
          aria-hidden
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted-foreground/15 text-foreground/70"
        >
          <KeyRound className="size-3" />
        </span>
        <span className="truncate">{messages.serviceAccount}</span>
      </span>
    )
  }

  const name = profile ? (profile.displayName ?? profile.email) : null

  return (
    <span
      className="inline-flex min-w-0 items-center gap-2"
      title={profile ? `${profile.email} · ${profile.id}` : requester.id}
    >
      <Avatar aria-hidden className="size-5">
        {profile?.avatarUrl ? <AvatarImage src={profile.avatarUrl} alt="" /> : null}
        <AvatarFallback className="bg-muted-foreground/15 text-[9px] font-medium tracking-tight text-foreground/75">
          {initials(name ?? messages.member)}
        </AvatarFallback>
      </Avatar>
      {name ? (
        <span className="truncate">{name}</span>
      ) : (
        <span className="min-w-0 truncate">
          {messages.member} <span className="font-mono text-xs">{requester.id}</span>
        </span>
      )}
    </span>
  )
}
