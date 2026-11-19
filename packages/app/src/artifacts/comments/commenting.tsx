import { cn } from "@sixb/ui/lib/utils"
import { useQueryClient } from "@tanstack/react-query"
import { MessageSquare, MessageSquarePlus } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { useCurrentUser } from "../../session"
import { commentsContext } from "../comments-context"
import { useArtifactMessages } from "../messages"
import { useAgentDraft, useArtifactView } from "../view-context"
import {
  type ArtifactCommentAnchor,
  addComment,
  type CommentThread,
  canManageComment,
  deleteComment,
  resolveComment,
  useArtifactComments,
  useCommentAuthors,
} from "./comments"
import type { CommentFilter } from "./panel"

// Commenting on an artifact, whatever its kind places a comment on: whether the reader is placing
// one, the thread open in the panel, which threads it lists, and what each action does. A kind
// adds where its comments go, a canvas's boards or a video's instants, and posts them with `add`.

/** What a new comment is about, as its kind places it; the artifact's revision is added. */
export type CommentPlace = Omit<Partial<ArtifactCommentAnchor>, "revision">

export function useArtifactCommenting({
  artifactId,
  kind,
  title,
  revision,
}: {
  /** The artifact commented on; null where its comments are not shown, as on an older version. */
  readonly artifactId: string | null
  readonly kind: "canvas" | "video"
  readonly title: string
  readonly revision: number
}) {
  const messages = useArtifactMessages().comments
  const queries = useQueryClient()
  const view = useArtifactView()
  const user = useCurrentUser()
  const agentDraft = useAgentDraft()
  const { threads, loading, failed } = useArtifactComments(artifactId)
  const nameOf = useCommentAuthors()

  const [commenting, setCommenting] = useState(false)
  const [panel, setPanel] = useState(false)
  const [filter, setFilter] = useState<CommentFilter>("open")
  const [active, setActive] = useState<string | null>(null)

  /** Posts a new comment there, and opens the panel at it. */
  const add = useCallback(
    async (place: CommentPlace, body: string) => {
      if (!artifactId) return
      const created = await addComment(queries, artifactId, {
        body,
        anchor: { ...place, revision },
      })
      setActive(created.id)
      setFilter("open")
      setPanel(true)
    },
    [artifactId, queries, revision]
  )

  const reply = useCallback(
    async (thread: CommentThread, body: string) => {
      if (!artifactId) return
      await addComment(queries, artifactId, { body, parentId: thread.comment.id })
    },
    [artifactId, queries]
  )

  const resolve = useCallback(
    async (thread: CommentThread, resolved: boolean) => {
      if (!artifactId) return
      await resolveComment(queries, artifactId, thread.comment.id, resolved)
      // A thread resolved leaves the open ones, and its pin with it.
      if (resolved) setActive((current) => (current === thread.comment.id ? null : current))
    },
    [artifactId, queries]
  )

  const remove = useCallback(
    async (thread: CommentThread) => {
      if (!artifactId) return
      await deleteComment(queries, artifactId, thread.comment.id)
      setActive((current) => (current === thread.comment.id ? null : current))
    },
    [artifactId, queries]
  )

  // Sent to the Agent, the comments go as context of the reader's message, a chip they read as
  // words; the sentence that asks for them is theirs to change.
  const send = useMemo(
    () =>
      agentDraft && artifactId
        ? (chosen: readonly CommentThread[]) => {
            if (chosen.length === 0) return
            const { context } = commentsContext({
              artifactId,
              kind,
              title,
              label: (count) => messages.contextLabel(count, title),
              threads: chosen,
            })
            agentDraft({ text: messages.askAgent, context })
          }
        : null,
    [agentDraft, messages, title, artifactId, kind]
  )

  const access = view?.access ?? "read"
  const userId = user?.id ?? null
  const canManage = useCallback(
    (comment: CommentThread["comment"]) => canManageComment(comment, access, userId),
    [access, userId]
  )

  /** A thread's pin, as the panel and the pins name it. */
  const pinLabel = useCallback(
    (thread: CommentThread) =>
      messages.pin(thread.number, nameOf(thread.comment)?.name ?? messages.someone),
    [messages, nameOf]
  )

  return {
    enabled: artifactId !== null,
    threads,
    loading,
    failed,
    open: threads.filter((thread) => !thread.comment.resolvedAt).length,
    nameOf,
    pinLabel,
    canManage,
    commenting,
    setCommenting,
    panel,
    setPanel,
    filter,
    setFilter,
    active,
    setActive,
    add,
    reply,
    resolve,
    remove,
    send,
  }
}

export type ArtifactCommenting = ReturnType<typeof useArtifactCommenting>

/** Whether a thread is among those the panel lists: the open ones, or those resolved. */
export function listed(thread: CommentThread, filter: CommentFilter): boolean {
  return Boolean(thread.comment.resolvedAt) === (filter === "resolved")
}

/**
 * The comment tool and the panel's toggle, side by side: the tool places a comment where the
 * reader clicks next, as C does; the toggle shows how many are open.
 */
export function CommentTools({
  commenting,
  onToggle,
  className,
}: {
  readonly commenting: Pick<ArtifactCommenting, "commenting" | "open" | "panel" | "setPanel">
  /** Starts or stops placing a comment. */
  readonly onToggle: () => void
  readonly className?: string
}) {
  const messages = useArtifactMessages().comments
  const active = commenting.commenting
  return (
    <div
      className={cn(
        "flex items-center gap-0.5 rounded-xl border border-border bg-background/95 p-1 shadow-[0_1px_2px_rgb(0_0_0/0.06),0_8px_24px_-12px_rgb(0_0_0/0.25)] backdrop-blur",
        className
      )}
      role="group"
      aria-label={messages.title}
    >
      <button
        type="button"
        aria-label={messages.tool}
        title={messages.toolHint}
        aria-pressed={active}
        aria-keyshortcuts="C"
        onClick={onToggle}
        className={cn(
          "flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4",
          active &&
            "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
        )}
      >
        <MessageSquarePlus aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={messages.toggle(commenting.open)}
        title={messages.toggle(commenting.open)}
        aria-pressed={commenting.panel}
        onClick={() => commenting.setPanel(!commenting.panel)}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-lg px-2 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4",
          commenting.panel && "bg-muted text-foreground"
        )}
      >
        <MessageSquare aria-hidden="true" />
        {commenting.open > 0 ? (
          <span className="text-xs font-medium tabular-nums">{commenting.open}</span>
        ) : null}
      </button>
    </div>
  )
}

/** Says, while the reader is placing a comment, what a click places it on, and how to stop. */
export function CommentModeHint({
  hint,
  onExit,
}: {
  readonly hint: string
  readonly onExit: () => void
}) {
  const messages = useArtifactMessages().comments
  return (
    <div
      role="status"
      className="pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full border border-border bg-background/95 py-1 pr-1 pl-3 text-xs text-muted-foreground shadow-[0_1px_2px_rgb(0_0_0/0.06),0_8px_24px_-12px_rgb(0_0_0/0.25)] backdrop-blur motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1"
    >
      <MessageSquarePlus className="size-3.5 shrink-0 text-foreground" aria-hidden="true" />
      <span className="min-w-0 truncate">{hint}</span>
      <button
        type="button"
        onClick={onExit}
        aria-label={messages.exit}
        title={messages.exit}
        className="shrink-0 rounded-full border border-border bg-muted px-1.5 font-mono text-[10px] leading-4 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        Esc
      </button>
    </div>
  )
}
