import type { CanvasBoard } from "@sixb/core/artifacts"
import { boardElements } from "@sixb/core/artifacts/live"
import { cn } from "@sixb/ui/lib/utils"
import { MessageSquarePlus } from "lucide-react"
import { useCallback, useMemo, useRef, useState } from "react"
import { listed, useArtifactCommenting } from "../../comments/commenting"
import type { CommentThread } from "../../comments/comments"
import { liveBoardSource } from "../../live/boards"
import type { LiveArtifact } from "../../live/session"
import { useArtifactMessages } from "../../messages"
import type { CommentPick } from "./board-editor"
import type { DraftPlace, PinPlace } from "./comment-pins"

// Commenting on a canvas, as the board and its opened boards share it, on top of what every
// artifact's comments do (../../comments/commenting.tsx): the comment being written and where, the
// threads' pins on their boards, and where the panel says each is. A comment placed on the canvas
// is about a board; one placed in an opened board is about the element the reader clicked, by its
// address and first words.

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
  const commenting = useArtifactCommenting({ artifactId, kind: "canvas", title, revision })
  const { threads, filter, pinLabel, add, setCommenting } = commenting
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
        if (!comment.anchor.board || !listed(thread, filter)) return []
        return [
          {
            id: comment.id,
            number: thread.number,
            board: comment.anchor.board,
            ...(comment.anchor.point ? { point: comment.anchor.point } : {}),
            resolved: Boolean(comment.resolvedAt),
            label: pinLabel(thread),
          },
        ]
      }),
    [threads, filter, pinLabel]
  )

  // What a new comment is about, as its card says it: the words it points at, else its board.
  const pick = useCallback(
    (board: string, place: CommentPick, where: CommentDraft["where"]) =>
      setDraft({
        board,
        ...place,
        anchor: place.anchor ?? (place.label ? `“${place.label}”` : (titles.get(board) ?? board)),
        where,
      }),
    [titles]
  )

  const submitDraft = useCallback(
    async (body: string) => {
      if (!draft) return
      await add(
        {
          board: draft.board,
          ...(draft.element ? { element: draft.element } : {}),
          ...(draft.label ? { label: draft.label } : {}),
          point: draft.point,
        },
        body
      )
      setDraft(null)
    },
    [draft, add]
  )

  return {
    ...commenting,
    pins,
    placeOf,
    toggleCommenting: () => {
      setCommenting((current) => !current)
      setDraft(null)
    },
    draft,
    pick,
    cancelDraft: () => setDraft(null),
    submitDraft,
  }
}

export type CanvasCommenting = ReturnType<typeof useCanvasCommenting>

/** What the panel shows of a thread's place: its board's title, and its element, or none left. */
export interface ThreadPlace {
  readonly board: string | null
  readonly element: string | null
  readonly gone: boolean
}

/** Where a thread is: its board, and its element by its first words, or that it is gone. */
export function ThreadWhere({ place }: { readonly place: ThreadPlace }) {
  const messages = useArtifactMessages().canvas.comments
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
      <span className="truncate font-medium text-foreground/80">
        {place.board ?? messages.onCanvas}
      </span>
      {place.board ? (
        <>
          <span aria-hidden="true">·</span>
          <span className={cn("min-w-0 truncate", place.gone && "line-through decoration-1")}>
            {place.element ? `“${place.element}”` : messages.wholeBoard}
          </span>
        </>
      ) : null}
      {place.gone ? (
        <span className="rounded-sm bg-muted px-1 text-[10.5px] text-muted-foreground">
          {messages.elementGone}
        </span>
      ) : null}
    </span>
  )
}

/** How to leave a canvas's first comment: the comment tool, then a board. */
export function CanvasCommentsHint() {
  const messages = useArtifactMessages()
  const hint = messages.canvas.comments.emptyHint
  return (
    <>
      {hint.before}{" "}
      <MessageSquarePlus
        className="inline size-3.5 align-[-0.2em] text-foreground"
        aria-label={messages.comments.tool}
      />{" "}
      {hint.after}
    </>
  )
}
