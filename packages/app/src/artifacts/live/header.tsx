import { cn } from "@sixb/ui/lib/utils"
import { Check, CloudOff, LoaderCircle, Sparkles, TriangleAlert } from "lucide-react"
import { useArtifactMessages } from "../messages"
import { PersonAvatar } from "../person-avatar"
import { useLivePresence } from "./presence"
import type { LiveArtifact, LiveArtifactState } from "./session"

/** The most people the header shows faces of; the rest count in a `+N`. */
const MAX_FACES = 3

/**
 * Who else is on the artifact, as faces beside the title, each ringed in the color their
 * selection takes on the canvas, and the Agent while a turn changes it. Nothing when nobody is.
 */
export function LiveAvatars({ live }: { readonly live: LiveArtifact }) {
  const messages = useArtifactMessages().live
  const { people, agents } = useLivePresence(live)
  const working = agents.length > 0
  if (people.length === 0 && !working) return null

  const shown = people.slice(0, MAX_FACES)
  const names = [...people.map((person) => person.name), ...(working ? [messages.agent] : [])]
  return (
    <div
      role="group"
      aria-label={messages.here(names.join(", "))}
      title={names.join(", ")}
      data-live-avatars=""
      className="flex shrink-0 items-center gap-0 pl-1 -space-x-1"
    >
      {working ? (
        <span
          data-live-agent=""
          className="relative flex size-6 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--primary)_14%,var(--background))] text-primary ring-2 ring-background"
        >
          <Sparkles className="size-3.5 motion-safe:animate-pulse" aria-hidden="true" />
        </span>
      ) : null}
      {shown.map((person) => (
        <span
          key={person.id}
          className="relative rounded-full"
          style={{ boxShadow: `0 0 0 1.5px var(--background), 0 0 0 3px ${person.color}` }}
        >
          <PersonAvatar name={person.name} size="sm" className="bg-background" />
        </span>
      ))}
      {people.length > shown.length ? (
        <span className="relative flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-background">
          {messages.more(people.length - shown.length)}
        </span>
      ) : null}
    </div>
  )
}

/** What the header says of an edit's write-back, as a document editor does. */
export type LiveSaveLabel = "saved" | "saving" | "failed" | "offline"

/**
 * Where what the reader changed is: saved, being saved, kept here while the socket is down, or
 * failed and tried again by the server.
 */
export function liveSaveLabel(state: LiveArtifactState): LiveSaveLabel {
  if (state.connection !== "online") return "offline"
  if (state.save?.state === "failed") return "failed"
  if (state.pending || state.save?.state === "unsaved" || state.save?.state === "saving") {
    return "saving"
  }
  return "saved"
}

/** The save state, discreet beside the title: its words fold into the icon on a narrow header. */
export function LiveSaveStatus({ state }: { readonly state: LiveArtifactState }) {
  const messages = useArtifactMessages().live
  const label = liveSaveLabel(state)
  const text = messages[label]
  const Icon =
    label === "saved"
      ? Check
      : label === "saving"
        ? LoaderCircle
        : label === "failed"
          ? TriangleAlert
          : CloudOff
  return (
    <span
      role="status"
      title={text}
      data-save={label}
      className={cn(
        "flex h-5 shrink-0 items-center gap-1 text-xs whitespace-nowrap transition-colors",
        label === "failed" ? "text-warning" : "text-muted-foreground"
      )}
    >
      <Icon
        className={cn("size-3.5", label === "saving" && "animate-spin motion-reduce:animate-none")}
        aria-hidden="true"
      />
      <span className="sr-only @2xl:not-sr-only">{text}</span>
    </span>
  )
}

/** Why the reader's hold on a live artifact changed: they may only watch now, or it is gone. */
export type LiveNoticeReason = "access" | "not_shared" | "not_found"

/** Under the header, when the reader's hold on the artifact changed, saying how. */
export function LiveNotice({ reason }: { readonly reason: LiveNoticeReason }) {
  const messages = useArtifactMessages().live
  const text =
    reason === "not_shared"
      ? messages.notShared
      : reason === "not_found"
        ? messages.deleted
        : messages.accessLost
  return (
    <p
      role="status"
      data-live-notice={reason}
      className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2 text-[13px] text-muted-foreground animate-in fade-in-0 duration-200"
    >
      <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
      {text}
    </p>
  )
}
