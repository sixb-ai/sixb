import type { CanvasBoard } from "@sixb/core/artifacts"
import { boardElements } from "@sixb/core/artifacts/live"
import { cn } from "@sixb/ui/lib/utils"
import { useQueryClient } from "@tanstack/react-query"
import { MessageSquare, MessageSquarePlus } from "lucide-react"
import { useCallback, useMemo, useRef, useState } from "react"
import { useCurrentUser } from "../../../session"
import { commentsContext } from "../../comments-context"
import { liveBoardSource } from "../../live/boards"
import type { LiveArtifact } from "../../live/session"
import { useArtifactMessages } from "../../messages"
import { useAgentDraft, useArtifactView } from "../../view-context"
import type { CommentPick } from "./board-editor"
import type { DraftPlace, PinPlace } from "./comment-pins"
import {
  addComment,
  type CommentThread,
  canManageComment,
  deleteComment,
  resolveComment,
  useArtifactComments,
  useCommentAuthors,
} from "./comments"
import type { CommentFilter, ThreadPlace } from "./comments-panel"

// Commenting on a canvas, as the board and its opened boards share it: whether the reader is
// placing a comment, the one they are writing and where, the thread open in the panel, and what
// each action does. A comment placed on the canvas is about a board; one placed in an opened
// board is about the element the reader clicked, by its address and first words.

/** Where a new comment is being written: on the canvas, or in the opened board. */
export type CommentDraft = DraftPlace & { readonly where: "canvas" | "focus" }

export function useCanvasCommenting({
  artifactId,
  live,
  title,
  boards,
  revision,
}: {
  readonly artifactId: string | null
  readonly live: LiveArtifact | null
  readonly title: string
  readonly boards: readonly CanvasBoard[]
  readonly revision: number
}) {
  const messages = useArtifactMessages().canvas.comments
  const queries = useQueryClient()
  const view = useArtifactView()
  const user = useCurrentUser()
  const agentDraft = useAgentDraft()
  const { threads, loading, failed } = useArtifactComments(artifactId, live)
  const nameOf = useCommentAuthors()

  const [commenting, setCommenting] = useState(false)
  const [panel, setPanel] = useState(false)
  const [filter, setFilter] = useState<CommentFilter>("open")
  const [active, setActive] = useState<string | null>(null)
  const [draft, setDraft] = useState<CommentDraft | null>(null)

  const titles = useMemo(
    () => new Map(boards.map((board) => [board.id, board.title ?? board.id])),
    [boards]
  )

  // Each board's addresses, read once per page as the document holds it, to tell a comment whose
  // element is gone.
  const addresses = useRef(new Map<string, { source: string; addresses: ReadonlySet<string> }>())
  const placeOf = useCallback(
    (thread: CommentThread): ThreadPlace => {
      const { anchor } = thread.comment
      const board = anchor.board ? boards.find((each) => each.id === anchor.board) : undefined
      const name = anchor.board ? (titles.get(anchor.board) ?? anchor.board) : null
      let gone = Boolean(anchor.board) && !board
      if (board && anchor.element && live) {
        const source = liveBoardSource(live.doc, board.file)
        if (source !== null) {
          let known = addresses.current.get(board.file)
          if (known?.source !== source) {
            known = {
              source,
              addresses: new Set(boardElements(source).map((element) => element.address)),
            }
            addresses.current.set(board.file, known)
          }
          gone = !known.addresses.has(anchor.element)
        }
      }
      return {
        board: name,
        element: anchor.element ? (anchor.label ?? null) : null,
        gone,
      }
    },
    [boards, titles, live]
  )

  // The pins of the threads the panel lists: the open ones, or those resolved.
  const pins = useMemo<PinPlace[]>(
    () =>
      threads.flatMap((thread) => {
        const { comment } = thread
        const resolved = Boolean(comment.resolvedAt)
        if (!comment.anchor.board) return []
        if (resolved !== (filter === "resolved")) return []
        return [
          {
            id: comment.id,
            number: thread.number,
            board: comment.anchor.board,
            ...(comment.anchor.point ? { point: comment.anchor.point } : {}),
            resolved,
            label: messages.pin(thread.number, nameOf(comment)?.name ?? messages.someone),
          },
        ]
      }),
    [threads, filter, messages, nameOf]
  )

  const pick = useCallback(
    (board: string, place: CommentPick, where: CommentDraft["where"]) =>
      setDraft({ board, ...place, where }),
    []
  )

  const submitDraft = useCallback(
    async (body: string) => {
      if (!draft || !artifactId) return
      const created = await addComment(queries, artifactId, {
        body,
        anchor: {
          board: draft.board,
          ...(draft.element ? { element: draft.element } : {}),
          ...(draft.label ? { label: draft.label } : {}),
          point: draft.point,
          revision,
        },
      })
      setDraft(null)
      setActive(created.id)
      setFilter("open")
      setPanel(true)
    },
    [draft, artifactId, queries, revision]
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
              title,
              label: (count) => messages.contextLabel(count, title),
              threads: chosen,
            })
            agentDraft({ text: messages.askAgent, context })
          }
        : null,
    [agentDraft, messages, title, artifactId]
  )

  const access = view?.access ?? "read"
  const userId = user?.id ?? null
  const canManage = useCallback(
    (comment: CommentThread["comment"]) => canManageComment(comment, access, userId),
    [access, userId]
  )

  return {
    enabled: artifactId !== null,
    threads,
    loading,
    failed,
    open: threads.filter((thread) => !thread.comment.resolvedAt).length,
    pins,
    nameOf,
    placeOf,
    canManage,
    commenting,
    setCommenting,
    toggleCommenting: () => {
      setCommenting((current) => !current)
      setDraft(null)
    },
    panel,
    setPanel,
    filter,
    setFilter,
    active,
    setActive,
    draft,
    pick,
    cancelDraft: () => setDraft(null),
    submitDraft,
    reply,
    resolve,
    remove,
    send,
  }
}

export type CanvasCommenting = ReturnType<typeof useCanvasCommenting>

/**
 * The comment tool and the panel's toggle, side by side: the tool places a comment where the
 * reader clicks next, as C does; the toggle shows how many are open.
 */
export function CommentTools({
  commenting,
  className,
}: {
  readonly commenting: CanvasCommenting
  readonly className?: string
}) {
  const messages = useArtifactMessages().canvas.comments
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
        onClick={commenting.toggleCommenting}
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

/** Says, while the reader is placing a comment, where a click puts it. */
export function CommentModeHint({ onExit }: { readonly onExit: () => void }) {
  const messages = useArtifactMessages().canvas.comments
  return (
    <div
      role="status"
      className="pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full bg-foreground py-1 pr-1 pl-3 text-xs text-background shadow-lg motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
    >
      <MessageSquarePlus className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{messages.modeHint}</span>
      <button
        type="button"
        onClick={onExit}
        className="shrink-0 rounded-full bg-background/15 px-2 py-0.5 font-medium outline-none hover:bg-background/25 focus-visible:ring-2 focus-visible:ring-background"
      >
        {messages.exit}
      </button>
    </div>
  )
}
