import { cn } from "@sixb/ui/lib/utils"
import { useStoreApi } from "@xyflow/react"
import type { LucideIcon } from "lucide-react"
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react"
import { ArtifactFrame } from "../../frame"
import type { ArtifactVersion } from "../../queries"
import type { BoardPreviews } from "./previews"

/** The most boards and embeds live at once: each board is a page running in its own frame. */
export const MAX_LIVE_BOARDS = 8
/**
 * A board starts running once the view shows it at half its size, where its page's text still
 * reads. Smaller, its picture shows as much, so it is its tile.
 */
export const LIVE_FROM_SCALE = 0.5
/**
 * Or, while it has no picture, once it is this wide on screen, a phone's width, where a wide
 * board's layout reads: its outline shows nothing of it.
 */
export const LIVE_FROM_WIDTH = 360

/** A board's or an embed's place on the canvas. */
export interface BoardPlace {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** Whether its tile is a picture of it: a board's ready preview. */
  readonly pictured?: boolean
}

/** Where the board view is: React Flow's transform, the pan then the zoom, and its size. */
export interface BoardView {
  readonly transform: readonly [number, number, number]
  readonly width: number
  readonly height: number
}

/**
 * The boards and embeds to run, from where the board view is: those on screen and large enough
 * there, or running already, at most {@link MAX_LIVE_BOARDS}. One running keeps running however
 * small while it is on screen, so zooming out never reloads it. Those running come first, so a
 * pan doesn't swap one page for another, then the nearest the middle of the view. The others show
 * their tile until the view comes to them.
 */
export function liveBoards(
  boards: readonly BoardPlace[],
  view: BoardView,
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
    const half = board.w * LIVE_FROM_SCALE
    const large = width >= (board.pictured ? half : Math.min(half, LIVE_FROM_WIDTH))
    const kept = running.has(board.id)
    if (!onScreen || (!large && !kept)) return []

    const distance = Math.hypot(left + width / 2 - centerX, top + height / 2 - centerY)
    return [{ id: board.id, kept, distance }]
  })

  candidates.sort((a, b) => Number(b.kept) - Number(a.kept) || a.distance - b.distance)
  return new Set(candidates.slice(0, MAX_LIVE_BOARDS).map((candidate) => candidate.id))
}

/**
 * The boards and embeds running, kept as the view moves. Each item reads whether it is one of
 * them, so a change draws again only the items it starts or stops, and a pan draws nothing.
 */
export interface LiveSet {
  readonly has: (id: string) => boolean
  readonly subscribe: (listener: () => void) => () => void
}

/** The live set of these boards and embeds, worked out again as React Flow's view changes. */
export function useLiveSet(places: readonly BoardPlace[]): LiveSet {
  const store = useStoreApi()
  const [live] = useState(createLiveSet)

  useEffect(() => {
    let last: BoardView | null = null
    const update = () => {
      const { transform, width, height, fitViewQueued } = store.getState()
      // Until the view is fitted, it is not where the reader will see it: a board there would
      // start only to be seen small.
      if (fitViewQueued) return

      // The store changes for more than the view: what doesn't move it changes nothing here.
      if (
        last &&
        last.width === width &&
        last.height === height &&
        last.transform.every((value, index) => value === transform[index])
      ) {
        return
      }

      last = { transform, width, height }
      live.set(liveBoards(places, last, live.current()))
    }

    update()
    return store.subscribe(update)
  }, [store, places, live])

  return live
}

function createLiveSet(): LiveSet & {
  readonly current: () => ReadonlySet<string>
  readonly set: (next: ReadonlySet<string>) => void
} {
  let current: ReadonlySet<string> = new Set()
  const listeners = new Set<() => void>()

  return {
    has: (id) => current.has(id),
    current: () => current,
    set: (next) => {
      if (next.size === current.size && [...next].every((id) => current.has(id))) return

      current = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const NOTHING_LIVE: LiveSet = { has: () => false, subscribe: () => () => {} }

interface LiveBoards {
  readonly version: ArtifactVersion | null
  readonly live: LiveSet
  /** Whether each board's picture is ready, and the mode the reader sees it in. */
  readonly previews: BoardPreviews
  readonly mode: "light" | "dark"
  /** Opens a board over the canvas. */
  readonly open?: (id: string) => void
}

const LiveBoardsContext = createContext<LiveBoards>({
  version: null,
  live: NOTHING_LIVE,
  previews: {},
  mode: "light",
})

/** The board view's version, the boards it runs, their pictures, and how to open one. */
export function useLiveBoards(): LiveBoards {
  return useContext(LiveBoardsContext)
}

/** Whether a board or an embed runs now: it draws again only as that changes. */
export function useLive(id: string): boolean {
  const { live } = useContext(LiveBoardsContext)
  return useSyncExternalStore(
    live.subscribe,
    () => live.has(id),
    () => false
  )
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
 * What a board or an embed shows while it doesn't run: a picture of it when there is one, else
 * its outline, the icon of what it is in the middle, breathing while its picture is on its way.
 * A picture that can't be loaded gives way to its fallback, then to the outline. The name above
 * says which it is.
 */
export function ItemTile({
  icon: Icon,
  preview,
  fallback,
  pending = false,
}: {
  readonly icon: LucideIcon
  /** A picture of the item, the size of its box. */
  readonly preview?: string
  /** Another picture of it, for when that one can't be loaded. */
  readonly fallback?: string
  readonly pending?: boolean
}) {
  const picture = usePicture(preview, fallback)

  if (picture.src) {
    return (
      <img
        src={picture.src}
        alt=""
        decoding="async"
        loading="lazy"
        draggable={false}
        onError={picture.fail}
        className="block size-full object-cover"
      />
    )
  }
  return (
    <div
      className={cn(
        "flex size-full items-center justify-center bg-card",
        pending && "motion-safe:animate-pulse"
      )}
      {...(pending ? { "aria-busy": true } : {})}
    >
      <Icon className="size-12 text-muted-foreground/30" strokeWidth={1} aria-hidden="true" />
    </div>
  )
}

const NOTHING_FAILED: ReadonlySet<string> = new Set()

/**
 * The picture to show of `preview`, else of `fallback` once it fails, without going blank as it
 * changes: the one shown stays until the next has decoded, so a sharper picture, or one in the
 * other mode, takes its place in one frame. Nothing is shown before the first one, which loads in
 * place, as an image does.
 */
function usePicture(
  preview: string | undefined,
  fallback: string | undefined
): { readonly src: string | null; readonly fail: () => void } {
  const [failed, setFailed] = useState(NOTHING_FAILED)
  const wanted = [preview, fallback].find((src) => src !== undefined && !failed.has(src)) ?? null
  const [shown, setShown] = useState(wanted)
  const showing = shown !== null && !failed.has(shown)

  useEffect(() => {
    if (wanted === shown) return

    // Nothing worth keeping on screen: the next one loads in place.
    if (!wanted || !showing) {
      setShown(wanted)
      return
    }

    let current = true
    const next = new Image()
    next.src = wanted
    next.decode().then(
      () => {
        if (current) setShown(wanted)
      },
      () => {
        if (current) setFailed((all) => new Set(all).add(wanted))
      }
    )
    return () => {
      current = false
    }
  }, [wanted, shown, showing])

  return {
    src: showing ? shown : wanted,
    fail: () => {
      const src = showing ? shown : wanted
      if (src) setFailed((all) => new Set(all).add(src))
    },
  }
}

/**
 * A board's page, running, when the view shows it large enough, over its tile: the tile stays
 * under the frame, which fades in once its page is ready, so a board never flashes blank as it
 * starts or stops. On the board a frame takes no clicks, so dragging across it pans; it is a
 * picture until the reader opens it.
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
  const { version } = useContext(LiveBoardsContext)
  const live = useLive(id)
  return (
    <div className="relative size-full">
      {tile}
      {version && live ? (
        <ArtifactFrame
          version={version}
          entry={file}
          title={title}
          decorative
          className="absolute inset-0 overflow-hidden rounded-[10px]"
        />
      ) : null}
    </div>
  )
}
