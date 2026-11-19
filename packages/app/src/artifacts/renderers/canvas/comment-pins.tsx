import { type InternalNode, useStore, ViewportPortal } from "@xyflow/react"
import { memo, type ReactNode, useCallback } from "react"
import { CommentPin, cardPlace, DraftCard } from "../../comments/composer"
import { useArtifactMessages } from "../../messages"

// Where a canvas's comments sit: a pin on its board, at the point its author clicked, and the card
// a new comment is written in where the reader clicked. On the canvas, pins keep their size on
// screen however far it is zoomed, as a design tool's comments do.

/** A comment's pin, as the canvas and an opened board draw it. */
export interface PinPlace {
  readonly id: string
  readonly number: number
  readonly board: string
  /** Where on the board, as fractions of its size; none sits at its top right corner. */
  readonly point?: { readonly x: number; readonly y: number }
  readonly resolved: boolean
  readonly label: string
}

/** A new comment's place, while it is being written. */
export interface DraftPlace {
  readonly board: string
  readonly element?: string
  readonly label?: string
  readonly point: { readonly x: number; readonly y: number }
  /** Where the element it is about ends, as a share of the board's height: its card sits under. */
  readonly under?: number
  /** What it is about, as its card says it: the element's words, or the board. */
  readonly anchor?: string
}

/** Where a pin without a point sits on its board, the `index`th of those, from its top right. */
export function pinPoint(pin: Pick<PinPlace, "point">, index: number): { x: number; y: number } {
  return pin.point ?? { x: 1, y: 0.02 + index * 0.06 }
}

interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * Every comment's pin over the canvas, on its board, and the new comment being written: drawn in
 * the canvas's coordinates, each kept at its size on screen.
 */
export const CanvasCommentPins = memo(function CanvasCommentPins({
  pins,
  active,
  draft,
  onOpen,
  onSubmitDraft,
  onCancelDraft,
}: {
  readonly pins: readonly PinPlace[]
  readonly active: string | null
  readonly draft: DraftPlace | null
  readonly onOpen: (id: string) => void
  readonly onSubmitDraft: (body: string) => Promise<void>
  readonly onCancelDraft: () => void
}) {
  const messages = useArtifactMessages().comments
  const zoom = useStore((state) => state.transform[2])
  const view = useStore(viewOf, sameView)
  const boards = [...new Set([...pins.map((pin) => pin.board), ...(draft ? [draft.board] : [])])]
  const boxes = useBoardBoxes(boards)
  const unplaced = new Map<string, number>()
  const scale = `scale(${1 / zoom})`
  const draftBox = draft ? boxes.get(draft.board) : undefined

  if (boxes.size === 0) return null
  return (
    <ViewportPortal>
      {pins.map((pin) => {
        const box = boxes.get(pin.board)
        if (!box) return null

        const index = pin.point ? 0 : (unplaced.get(pin.board) ?? 0)
        if (!pin.point) unplaced.set(pin.board, index + 1)
        const at = pinPoint(pin, index)
        return (
          <div
            key={pin.id}
            className="pointer-events-none absolute top-0 left-0"
            style={{
              transform: `translate(${box.x + at.x * box.w}px, ${box.y + at.y * box.h}px) ${scale}`,
              transformOrigin: "0 0",
            }}
          >
            <CommentPin
              number={pin.number}
              label={pin.label}
              active={active === pin.id}
              resolved={pin.resolved}
              onClick={() => onOpen(pin.id)}
            />
          </div>
        )
      })}
      {draft && draftBox ? (
        <DraftAt box={draftBox} draft={draft} scale={scale}>
          <CommentPin label={messages.newPin} active resolved={false} draft />
          <div
            className="absolute top-0"
            style={cardPlace(view.x + (draftBox.x + draft.point.x * draftBox.w) * zoom, view.width)}
          >
            <DraftCard
              {...(draft.anchor ? { anchor: draft.anchor } : {})}
              onSubmit={onSubmitDraft}
              onCancel={onCancelDraft}
            />
          </div>
        </DraftAt>
      ) : null}
    </ViewportPortal>
  )
})

function DraftAt({
  box,
  draft,
  scale,
  children,
}: {
  readonly box: Box
  readonly draft: DraftPlace
  readonly scale: string
  readonly children: ReactNode
}) {
  return (
    <div
      className="pointer-events-none absolute top-0 left-0"
      style={{
        transform: `translate(${box.x + draft.point.x * box.w}px, ${box.y + draft.point.y * box.h}px) ${scale}`,
        transformOrigin: "0 0",
      }}
    >
      {children}
    </div>
  )
}

/** Where the view is panned to, and how wide it is: a new comment's card stays in it. */
function viewOf(state: { readonly transform: readonly number[]; readonly width: number }) {
  return { x: state.transform[0] ?? 0, width: state.width }
}

function sameView(left: { x: number; width: number }, right: { x: number; width: number }) {
  return left.x === right.x && left.width === right.width
}

/** The boxes of these boards, read again only as one of them moves or changes size. */
function useBoardBoxes(ids: readonly string[]): ReadonlyMap<string, Box> {
  const key = ids.join("\n")
  const select = useCallback(
    (state: { readonly nodeLookup: ReadonlyMap<string, InternalNode> }) => {
      const boxes = new Map<string, Box>()
      for (const id of key ? key.split("\n") : []) {
        const node = state.nodeLookup.get(id)
        const w = node?.measured.width ?? node?.width
        const h = node?.measured.height ?? node?.height
        if (!node || w === undefined || h === undefined) continue
        const { x, y } = node.internals.positionAbsolute
        boxes.set(id, { x, y, w, h })
      }
      return boxes
    },
    [key]
  )
  return useStore(select, sameBoxes)
}

function sameBoxes(left: ReadonlyMap<string, Box>, right: ReadonlyMap<string, Box>): boolean {
  if (left.size !== right.size) return false
  for (const [id, box] of left) {
    const other = right.get(id)
    if (
      !other ||
      other.x !== box.x ||
      other.y !== box.y ||
      other.w !== box.w ||
      other.h !== box.h
    ) {
      return false
    }
  }
  return true
}
