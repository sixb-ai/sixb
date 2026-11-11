import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  clampSize,
  isScreen,
  type PageSize,
  type SizeName,
  type SnappedSize,
  sameSize,
  sizeSuggestions,
} from "./page-size"

/** A common screen's width the reader chose, and whether each board shows its full page at it. */
interface Screen {
  readonly w: number
  readonly full: boolean
}

/**
 * The size an opened board's page is shown at, for the reader alone, while the boards are open.
 *
 * A size set on a board stays on it as the reader steps through the others. A common screen's
 * width, picked or snapped to, carries to them: each is shown at it, at its own board's height, or
 * its full page once the reader chose that, so a flow is walked at a phone's width. Back to board
 * size puts every board back.
 */
export function useShownSize(id: string, own: PageSize) {
  const [sizes, setSizes] = useState<Readonly<Record<string, PageSize>>>({})
  const [screen, setScreen] = useState<Screen | null>(null)
  // Each board's page height, as its frame reports it at the width shown.
  const [heights, setHeights] = useState<Readonly<Record<string, number>>>({})

  const height = heights[id] ?? null
  const suggestions = useMemo(() => sizeSuggestions(own, height), [own, height])
  const chosen =
    sizes[id] ??
    (screen
      ? clampSize(
          { w: screen.w, h: screen.full && height !== null ? height : own.h },
          suggestions.least
        )
      : null)
  const shown = chosen && !sameSize(chosen, own) ? chosen : own

  const onContentHeight = useCallback(
    (next: number) => setHeights((last) => (last[id] === next ? last : { ...last, [id]: next })),
    [id]
  )

  /** A size laid out on this board, as a resize goes. */
  const resize = useCallback(
    (size: PageSize) => setSizes((last) => ({ ...last, [id]: size })),
    [id]
  )

  /**
   * A size set on this board: a common screen's width carries to the others, and `full`, when
   * given, says whether they show their full page at it.
   */
  const set = (size: PageSize, name: SizeName | null, full: boolean | null) => {
    if (name !== null && isScreen(name)) {
      setSizes({ [id]: size })
      setScreen({ w: size.w, full: full ?? screen?.full ?? false })
      return
    }
    resize(size)
    if (screen && full !== null) setScreen({ ...screen, full })
  }

  // A size kept as the board's is no longer one of the reader's once the board has it: should
  // the board change again, as with Undo, it shows as it is.
  const keeping = useRef<{ readonly id: string; readonly size: PageSize } | null>(null)
  useEffect(() => {
    const kept = keeping.current
    if (!kept || kept.id !== id || !sameSize(kept.size, own)) return

    keeping.current = null
    setSizes(({ [id]: _, ...others }) => others)
  }, [id, own])

  return {
    shown,
    resized: shown !== own,
    suggestions,
    /** The page's height as its frame reports it. */
    onContentHeight,
    resize,
    /** A size picked from the menu. */
    pick: (size: PageSize, name: SizeName) =>
      set(size, name, name === "full" ? true : isScreen(name) ? false : null),
    /** A resize ended, at what it snapped to: a free one stays on this board. */
    settle: (snapped: SnappedSize) => {
      const width = snapped.w && isScreen(snapped.w.name) ? snapped.w.name : null
      set(snapped.size, width, snapped.h ? snapped.h.name === "full" : null)
    },
    /** Back to the board's size: every board's, and no screen's width carried any more. */
    reset: () => {
      setSizes({})
      setScreen(null)
    },
    /** The size shown was kept as the board's. */
    keep: () => {
      keeping.current = { id, size: shown }
    },
  }
}
