import { cn } from "@sixb/ui/lib/utils"
import { ChevronDown, ChevronUp, X } from "lucide-react"
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useDeferredValue,
  useRef,
  useState,
} from "react"
import { useArtifactMessages } from "../../messages"

/** What the grid searches for, and which of its matches is the current one. */
export interface SheetFind {
  readonly query: string
  /** Counts on past either end: the grid wraps it around its matches. */
  readonly index: number
}

/** What the grid found for the query it was given. */
export interface SheetFindCount {
  readonly count: number
  readonly capped: boolean
}

/**
 * A sheet's find bar, opened by Cmd+F or Ctrl+F while focus is inside the sheet so the browser's
 * own find keeps working elsewhere on the page. The query reaches the grid deferred, so typing
 * stays quick on a large sheet.
 */
export function useSheetFind(gridRoot: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)
  const [found, setFound] = useState<SheetFindCount>({ count: 0, capped: false })
  const input = useRef<HTMLInputElement | null>(null)
  const deferred = useDeferredValue(query)

  const show = useCallback(() => {
    setOpen(true)
    // The input mounts with the bar; select what it holds, as a browser's find does.
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.select()
    })
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    gridRoot.current?.querySelector<HTMLElement>('[role="grid"]')?.focus({ preventScroll: true })
  }, [gridRoot])

  /** For the sheet's root: Cmd+F or Ctrl+F opens the bar, or selects its query again. */
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault()
        show()
      }
    },
    [show]
  )

  return {
    open,
    show,
    close,
    onKeyDown,
    input,
    query,
    setQuery: (value: string) => {
      setQuery(value)
      setIndex(0)
    },
    found,
    onFound: setFound,
    step: (by: number) => setIndex((current) => current + by),
    index,
    /** What the grid searches for: nothing while the bar is shut. */
    find: open && deferred.trim() ? { query: deferred, index } : undefined,
  }
}

export function FindBar({
  state,
  className,
}: {
  readonly state: ReturnType<typeof useSheetFind>
  readonly className?: string
}) {
  const messages = useArtifactMessages().sheet
  const { found, query } = state
  const current = found.count === 0 ? 0 : modulo(state.index, found.count) + 1
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      state.step(event.shiftKey ? -1 : 1)
    } else if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      state.close()
    }
  }
  return (
    <div
      role="search"
      className={cn("flex min-w-0 flex-1 items-center gap-1", className)}
      aria-label={messages.find}
    >
      <input
        ref={state.input}
        type="search"
        value={query}
        onChange={(event) => state.setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={messages.find}
        aria-label={messages.find}
        className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-2 text-[13px] outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
      />
      <span className="shrink-0 px-1 text-xs text-muted-foreground tabular-nums" aria-live="polite">
        {query.trim()
          ? found.count === 0
            ? messages.noMatches
            : messages.matchOf(current, found.count, found.capped)
          : ""}
      </span>
      <FindButton
        label={messages.previousMatch}
        disabled={found.count === 0}
        onClick={() => state.step(-1)}
      >
        <ChevronUp className="size-4" aria-hidden="true" />
      </FindButton>
      <FindButton
        label={messages.nextMatch}
        disabled={found.count === 0}
        onClick={() => state.step(1)}
      >
        <ChevronDown className="size-4" aria-hidden="true" />
      </FindButton>
      <FindButton label={messages.closeFind} onClick={state.close}>
        <X className="size-4" aria-hidden="true" />
      </FindButton>
    </div>
  )
}

function FindButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  readonly label: string
  readonly disabled?: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  )
}

/** Where an index that ran past either end lands among `count` matches. */
export function modulo(value: number, count: number): number {
  return ((value % count) + count) % count
}
