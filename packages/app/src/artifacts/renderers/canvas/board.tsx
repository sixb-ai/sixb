import { createContext, type ReactNode, useContext } from "react"
import { ArtifactFrame } from "../../frame"
import type { ArtifactVersion } from "../../queries"

/** The most boards live at once: each is a page running in its own frame. */
export const MAX_LIVE_BOARDS = 12
/**
 * How wide on screen a board is before it starts running: narrower, it is its outline. One already
 * running keeps running however small, so zooming out never reloads it.
 */
export const MIN_LIVE_WIDTH = 48

/** A board's place on the canvas. */
export interface BoardPlace {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * The boards to run, from where the board view is: those on screen and at least
 * {@link MIN_LIVE_WIDTH} wide there, or running already, at most {@link MAX_LIVE_BOARDS}. Those
 * running come first, so a pan doesn't swap one page for another, then the nearest the middle of
 * the view. The others show their outline until the view comes to them.
 */
export function liveBoards(
  boards: readonly BoardPlace[],
  view: {
    /** React Flow's transform: the pan, then the zoom. */
    readonly transform: readonly [number, number, number]
    readonly width: number
    readonly height: number
  },
  running: ReadonlySet<string> = new Set()
): ReadonlySet<string> {
  const [panX, panY, zoom] = view.transform
  const centerX = view.width / 2
  const centerY = view.height / 2
  const candidates = boards.flatMap((board) => {
    const left = board.x * zoom + panX
    const top = board.y * zoom + panY
    const width = board.w * zoom
    const height = board.h * zoom
    const onScreen = left < view.width && left + width > 0 && top < view.height && top + height > 0
    const kept = running.has(board.id)
    if (!onScreen || (width < MIN_LIVE_WIDTH && !kept)) return []
    const distance = Math.hypot(left + width / 2 - centerX, top + height / 2 - centerY)
    return [{ id: board.id, kept, distance }]
  })
  candidates.sort((a, b) => Number(b.kept) - Number(a.kept) || a.distance - b.distance)
  return new Set(candidates.slice(0, MAX_LIVE_BOARDS).map((candidate) => candidate.id))
}

interface LiveBoards {
  readonly version: ArtifactVersion | null
  readonly live: ReadonlySet<string>
  /** Opens a board over the canvas. */
  readonly open?: (id: string) => void
}

const LiveBoardsContext = createContext<LiveBoards>({ version: null, live: new Set() })

/** The board view's version, the boards it runs, and how to open one. */
export function useLiveBoards(): LiveBoards {
  return useContext(LiveBoardsContext)
}

export function LiveBoardsProvider({
  value,
  children,
}: {
  readonly value: LiveBoards
  readonly children: ReactNode
}) {
  return <LiveBoardsContext.Provider value={value}>{children}</LiveBoardsContext.Provider>
}

/**
 * A board's page, running, when the view shows it large enough: otherwise, and until it is ready,
 * its tile. On the board a frame takes no clicks, so dragging across it pans; it is a picture
 * until the reader opens it.
 */
export function LiveBoard({
  id,
  file,
  title,
  tile,
}: {
  readonly id: string
  readonly file: string
  readonly title: string
  readonly tile: ReactNode
}) {
  const { version, live } = useContext(LiveBoardsContext)
  if (!version || !live.has(id)) return <>{tile}</>
  return (
    <ArtifactFrame
      version={version}
      entry={file}
      title={title}
      decorative
      className="size-full overflow-hidden rounded-[10px]"
      fallback={tile}
    />
  )
}
