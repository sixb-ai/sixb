import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Check, Proportions, RotateCcw } from "lucide-react"
import { useRef } from "react"
import { useArtifactMessages } from "../../messages"
import { type PageSize, SCREENS, type SizeName, type SizeSuggestions, sameSize } from "./page-size"

/** The sizes the menu offers: the board's, the full page, and the common screens. */
const MENU: readonly SizeName[] = ["board", "full", "phone", "tablet", "desktop"]

/** A size the menu offers, as it lays the page out from the size shown now. */
function menuSize(
  name: SizeName,
  shown: PageSize,
  board: PageSize,
  suggestions: SizeSuggestions
): PageSize | null {
  if (name === "board") return board
  if (name === "full") {
    const full = suggestions.heights.find((each) => each.name === "full")?.h
    return full === undefined ? null : { w: shown.w, h: full }
  }
  const screen = SCREENS.find((each) => each.name === name)
  return screen && "h" in screen ? { w: screen.w, h: screen.h } : null
}

/**
 * The page's size in the opened board's header. Its menu offers what the handles snap to, for
 * those who would rather click, and is the way on a phone. Shown at another size than the
 * board's, it says which, and beside it, on a wide header, or in its menu, offers the way back
 * and, to whoever may change the canvas, Keep this size.
 */
export function SizeControls({
  shown,
  board,
  suggestions,
  kept,
  onPick,
  onReset,
  onKeep,
}: {
  readonly shown: PageSize
  readonly board: PageSize
  readonly suggestions: SizeSuggestions
  /** A size just kept as the board's, said for a moment. */
  readonly kept: PageSize | null
  /** A size picked from the menu, by what it is. */
  readonly onPick: (size: PageSize, name: SizeName) => void
  /** Back to the board's own size. */
  readonly onReset: () => void
  /** Keeps the size shown as the board's; absent for whoever may not change the canvas. */
  readonly onKeep?: (() => void) | undefined
}) {
  const messages = useArtifactMessages().canvas.size
  const resized = !sameSize(shown, board)
  // Picked with the pointer, the menu gives the focus back to nothing: given back to its
  // trigger, the browser would ring it as if the keyboard had.
  const pointer = useRef(false)
  const sizes = MENU.map((name) => ({ name, size: menuSize(name, shown, board, suggestions) }))
  // The first that is the size shown: the board's own before a screen of the same size.
  const current = sizes.find(({ size }) => size !== null && sameSize(size, shown))?.name

  return (
    <div className="flex shrink-0 items-center gap-1">
      {kept ? (
        <span
          role="status"
          className="flex items-center gap-1.5 px-2 text-xs font-medium text-foreground motion-safe:animate-in motion-safe:fade-in"
        >
          <Check className="size-3.5 text-primary" aria-hidden="true" />
          <span className="@max-3xl/canvas:sr-only">{messages.kept(kept.w, kept.h)}</span>
        </span>
      ) : null}

      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          onPointerDown={() => {
            pointer.current = true
          }}
          onKeyDown={() => {
            pointer.current = false
          }}
          aria-label={
            resized ? `${messages.menu}, ${messages.dimensions(shown.w, shown.h)}` : messages.menu
          }
          title={resized ? messages.yoursOnly : messages.menu}
          className={cn(
            "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted",
            resized
              ? "bg-primary/10 text-primary hover:bg-primary/15 data-[state=open]:bg-primary/15"
              : "text-muted-foreground hover:text-foreground data-[state=open]:text-foreground"
          )}
        >
          <Proportions className="size-4" aria-hidden="true" />
          {resized ? (
            <span className="text-xs tabular-nums max-sm:hidden">
              {messages.dimensions(shown.w, shown.h)}
            </span>
          ) : (
            <span className="max-md:hidden">{messages.label}</span>
          )}
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="w-[min(17rem,calc(100vw-2rem))] p-1.5"
          onPointerDown={() => {
            pointer.current = true
          }}
          onKeyDown={() => {
            pointer.current = false
          }}
          onCloseAutoFocus={(event) => {
            if (pointer.current) event.preventDefault()
          }}
        >
          <DropdownMenuLabel className="px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {messages.menu}
          </DropdownMenuLabel>

          {sizes.map(({ name, size }) => (
            <DropdownMenuItem
              key={name}
              disabled={size === null}
              onSelect={() => {
                if (name === "board") onReset()
                else if (size) onPick(size, name)
              }}
              className="gap-2 rounded-md py-1.5"
            >
              <Check
                className={cn("size-3.5", name === current ? "text-foreground" : "invisible")}
                aria-hidden="true"
              />
              <span className="flex-1 text-[13px]">{messages.names[name]}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {size ? messages.dimensions(size.w, size.h) : messages.measuring}
              </span>
            </DropdownMenuItem>
          ))}

          {resized ? (
            <>
              <DropdownMenuSeparator className="my-1" />
              <p className="px-2 pt-0.5 pb-1 text-xs text-muted-foreground">
                {onKeep ? messages.yoursUntilKept : messages.yoursOnly}
              </p>
              {onKeep ? (
                <DropdownMenuItem
                  onSelect={onKeep}
                  className="rounded-md py-1.5 pl-[30px] text-[13px] font-medium text-primary focus:text-primary"
                >
                  {messages.keep}
                </DropdownMenuItem>
              ) : null}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {resized ? (
        <span className="hidden items-center gap-1 @3xl/canvas:flex">
          <button
            type="button"
            aria-label={messages.reset}
            title={messages.reset}
            onClick={onReset}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
          </button>
          {onKeep ? (
            <button
              type="button"
              onClick={onKeep}
              className="h-7 shrink-0 rounded-lg bg-primary px-2.5 text-xs font-medium whitespace-nowrap text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              {messages.keep}
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}
