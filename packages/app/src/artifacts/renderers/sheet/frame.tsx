import { parseSheetPart } from "@sixb/core/artifacts"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronLeft, ChevronRight, Menu } from "lucide-react"
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { type ArtifactMessages, useArtifactMessages } from "../../messages"
import { FindBar, type useSheetFind } from "./find-bar"
import { cellFormatter, numberFormat } from "./format"
import type { SheetGridStatus } from "./grid"
import type { SheetModel } from "./model"
import type { CellRange } from "./selection"
import type { SheetView, SheetViewUpdate } from "./view"

/**
 * The bar above a sheet, as a spreadsheet's formula bar: the name box with the selection's address,
 * where the reader can type a cell or range to go to; the active cell's whole value after `fx`; and
 * the sheet's tools at the end.
 */
export function CommandBar({
  address,
  value,
  onGoTo,
  tools,
}: {
  readonly address: string
  readonly value: ReactNode
  /** Goes to what the reader typed in the name box; false when it names no cell or range. */
  readonly onGoTo?: (text: string) => boolean
  readonly tools?: ReactNode
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 bg-background pr-2 pl-2">
      <NameBox address={address} onGoTo={onGoTo} />
      <span className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />
      <span
        aria-hidden="true"
        className="shrink-0 px-0.5 font-serif text-[13px] text-muted-foreground/80 italic select-none"
      >
        fx
      </span>
      <span
        data-sheet-value=""
        className="min-w-0 flex-1 overflow-x-auto text-[13px] whitespace-nowrap select-text [scrollbar-width:none]"
      >
        {value}
      </span>
      {tools ? <div className="flex shrink-0 items-center gap-0.5">{tools}</div> : null}
    </div>
  )
}

/**
 * The selection's address, which the reader can type over to go to a cell or a range, as in a
 * spreadsheet's name box: Enter goes, Esc puts the address back, and a name that is no cell or
 * range is marked for the reader to fix.
 */
function NameBox({
  address,
  onGoTo,
}: {
  readonly address: string
  readonly onGoTo?: (text: string) => boolean
}) {
  const messages = useArtifactMessages().sheet
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const done = (input: HTMLInputElement) => {
    setDraft(null)
    setInvalid(false)
    input.blur()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      done(event.currentTarget)
    } else if (event.key === "Enter") {
      event.preventDefault()
      if (onGoTo?.(event.currentTarget.value)) done(event.currentTarget)
      else setInvalid(true)
    }
  }
  return (
    <input
      aria-label={messages.nameBox}
      title={messages.nameBox}
      readOnly={!onGoTo}
      value={draft ?? address}
      spellCheck={false}
      autoComplete="off"
      onFocus={(event) => {
        setDraft(address)
        event.currentTarget.select()
      }}
      onBlur={() => {
        setDraft(null)
        setInvalid(false)
      }}
      onChange={(event) => {
        setDraft(event.target.value)
        setInvalid(false)
      }}
      onKeyDown={onKeyDown}
      aria-invalid={invalid || undefined}
      className={cn(
        "h-7 w-20 shrink-0 rounded-md border border-border/70 bg-card px-2 font-mono text-xs tabular-nums shadow-[inset_0_1px_1px_rgb(0_0_0/0.03)] outline-none transition-colors hover:border-border focus:border-ring focus:ring-2 focus:ring-ring/20 @md:w-28",
        invalid && "border-destructive focus:border-destructive focus:ring-destructive/20"
      )}
    />
  )
}

/** The range a name box's text names, read as an address within the sheet. */
export function nameBoxRange(text: string): CellRange | null {
  const part = parseSheetPart(`sheet!${text.trim().replace(/\$/g, "")}`)
  return part?.type === "sheet" && part.range ? part.range : null
}

/** A tool in the command bar: an icon, with its name beside it where there is room. */
export function CommandButton({
  label,
  icon,
  pressed,
  onClick,
  showLabel = false,
}: {
  readonly label: string
  readonly icon: ReactNode
  readonly pressed?: boolean
  readonly onClick: () => void
  readonly showLabel?: boolean
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5",
        pressed
          ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
          : "text-muted-foreground"
      )}
    >
      {icon}
      {showLabel ? <span className="hidden @lg:inline">{label}</span> : null}
    </button>
  )
}

/** The find box, floating over the grid's top right as a spreadsheet's find does. */
export function FindPanel({ finder }: { readonly finder: ReturnType<typeof useSheetFind> }) {
  if (!finder.open) return null
  return (
    <div className="absolute top-2 right-3 z-30 w-[min(22rem,calc(100%-1.5rem))] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-[0_8px_24px_-8px_rgb(0_0_0/0.18),0_1px_2px_rgb(0_0_0/0.06)]">
      <FindBar state={finder} />
    </div>
  )
}

export interface SheetTabItem {
  readonly key: string
  readonly label: ReactNode
  /** The tab's name as text, for the list of every sheet. */
  readonly name: string
}

/**
 * The bar below a sheet, as a spreadsheet's: the workbook's tabs at the start, with arrows to scroll
 * them and a list of every sheet, and the status figures at the end. Without tabs, as for a CSV
 * file, it holds the figures alone.
 */
export function SheetBar({
  tabs,
  status,
}: {
  readonly tabs?: {
    readonly items: readonly SheetTabItem[]
    readonly current: number
    readonly onSelect: (index: number) => void
    /** Each tab's id, and the panel they control. */
    readonly tabId: (index: number) => string
    readonly panelId: string
  }
  readonly status: ReactNode
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col border-t border-border bg-[color-mix(in_oklab,var(--muted)_60%,var(--background))] @3xl:h-9 @3xl:flex-row @3xl:items-stretch",
        !tabs && "h-9 flex-row items-stretch"
      )}
    >
      {tabs ? <SheetTabs {...tabs} /> : null}
      <div
        className={cn(
          "flex min-h-8 min-w-0 shrink-0 items-center gap-x-4 overflow-x-auto px-3 text-xs whitespace-nowrap text-muted-foreground tabular-nums [scrollbar-width:none]",
          tabs ? "border-t border-border/70 @3xl:ml-auto @3xl:border-t-0" : "flex-1"
        )}
      >
        {status}
      </div>
    </div>
  )
}

function SheetTabs({
  items,
  current,
  onSelect,
  tabId,
  panelId,
}: {
  readonly items: readonly SheetTabItem[]
  readonly current: number
  readonly onSelect: (index: number) => void
  readonly tabId: (index: number) => string
  readonly panelId: string
}) {
  const messages = useArtifactMessages().sheet
  const strip = useRef<HTMLDivElement | null>(null)
  const [edges, setEdges] = useState({ start: true, end: true })

  // Which ends of the strip are in view, for its arrows.
  useLayoutEffect(() => {
    const element = strip.current
    if (!element) return
    const measure = () =>
      setEdges({
        start: element.scrollLeft <= 1,
        end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 1,
      })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    element.addEventListener("scroll", measure, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener("scroll", measure)
    }
  }, [])

  // The open tab stays in view, as the reader moves through them or picks one from the list.
  useEffect(() => {
    strip.current
      ?.querySelectorAll<HTMLElement>('[role="tab"]')
      [current]?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
  }, [current])

  const scroll = (way: number) => {
    const element = strip.current
    if (element) element.scrollBy({ left: way * element.clientWidth * 0.75, behavior: "smooth" })
  }

  // Arrow keys move along the tabs and open the one they reach, as a spreadsheet's tabs do.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = tabKeyTarget(event.key, current, items.length)
    if (next === null) return
    event.preventDefault()
    event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
    onSelect(next)
  }

  const overflowing = !(edges.start && edges.end)
  return (
    <div className="flex h-9 min-w-0 flex-1 items-stretch">
      <div className="flex shrink-0 items-center gap-0.5 px-1.5">
        {overflowing ? (
          <>
            <BarButton
              label={messages.previousSheets}
              disabled={edges.start}
              onClick={() => scroll(-1)}
            >
              <ChevronLeft />
            </BarButton>
            <BarButton label={messages.nextSheets} disabled={edges.end} onClick={() => scroll(1)}>
              <ChevronRight />
            </BarButton>
          </>
        ) : null}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            aria-label={messages.allSheets}
            title={messages.allSheets}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5"
          >
            <Menu aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="max-h-80 min-w-52">
            <DropdownMenuRadioGroup
              value={String(current)}
              onValueChange={(value) => onSelect(Number(value))}
            >
              {items.map((item, index) => (
                <DropdownMenuRadioItem key={item.key} value={String(index)}>
                  <span className="truncate">{item.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        ref={strip}
        role="tablist"
        aria-label={messages.tabs}
        onKeyDown={onKeyDown}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]"
      >
        {items.map((item, index) => {
          const selected = index === current
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              id={tabId(index)}
              aria-selected={selected}
              aria-controls={panelId}
              // One stop in the tab order: the arrows move between the tabs.
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(index)}
              className={cn(
                "relative -mt-px flex shrink-0 items-center gap-1.5 border-x px-3.5 text-[12.5px] whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                selected
                  ? "z-[1] border-border bg-card font-semibold text-foreground shadow-[inset_0_-2px_0_var(--primary)]"
                  : "border-transparent text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                // A hairline between neighbouring tabs that are not open.
                !selected &&
                  index + 1 !== current &&
                  "after:absolute after:inset-y-2.5 after:right-[-1px] after:w-px after:bg-border"
              )}
            >
              {item.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function BarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string
  readonly disabled: boolean
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
      className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-3.5"
    >
      {children}
    </button>
  )
}

/** Where an arrow, Home, or End key moves from one tab of `count`; null for any other key. */
function tabKeyTarget(key: string, current: number, count: number): number | null {
  if (count === 0) return null
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count
    case "ArrowLeft":
      return (current - 1 + count) % count
    case "Home":
      return 0
    case "End":
      return count - 1
    default:
      return null
  }
}

/**
 * What the status bar says: how many rows the sheet holds or its filters keep, what is frozen or
 * hidden, each with a way back, and the figures of the selection, as a spreadsheet's status bar
 * sums it.
 */
export function StatusFigures({
  model,
  status,
  view,
  onViewChange,
  locale,
  messages,
}: {
  readonly model: SheetModel
  readonly status: SheetGridStatus | null
  readonly view: SheetView
  readonly onViewChange: SheetViewUpdate
  readonly locale: string
  readonly messages: ArtifactMessages
}) {
  const stats = status?.stats
  // One numeric column reads in its own format; a wider selection as plain numbers.
  const single = status && status.range.left === status.range.right ? status.column : undefined
  const format = (value: number) =>
    single?.numeric
      ? cellFormatter(single, locale)(String(value)).text
      : numberFormat(locale, { maximumFractionDigits: 2 }).format(value)
  const filtered = status && status.rows < model.rows.length
  return (
    <>
      <span className="flex items-center gap-1.5">
        {filtered ? (
          <>
            {messages.sheet.filteredRows(status.rows, model.rows.length)}
            <StatusAction onClick={() => onViewChange((current) => ({ ...current, filters: {} }))}>
              {messages.sheet.clearFilters}
            </StatusAction>
          </>
        ) : (
          messages.sheet.rows(model.rows.length)
        )}
      </span>
      {view.hidden.length > 0 ? (
        <span className="flex items-center gap-1.5">
          {messages.sheet.hiddenColumns(view.hidden.length)}
          <StatusAction onClick={() => onViewChange((current) => ({ ...current, hidden: [] }))}>
            {messages.sheet.showHidden}
          </StatusAction>
        </span>
      ) : null}
      {model.frozenRows > 0 ? (
        <span className="hidden @5xl:inline">{messages.sheet.frozenRows(model.frozenRows)}</span>
      ) : null}
      {stats && stats.count > 1 ? (
        <>
          {stats.numericCount > 0 ? (
            <>
              {stats.average !== undefined ? (
                <Stat label={messages.sheet.average} value={format(stats.average)} />
              ) : null}
              {stats.min !== undefined && stats.max !== undefined ? (
                <>
                  <Stat label={messages.sheet.min} value={format(stats.min)} />
                  <Stat label={messages.sheet.max} value={format(stats.max)} />
                </>
              ) : null}
            </>
          ) : null}
          <Stat label={messages.sheet.count} value={stats.count.toLocaleString(locale)} />
          {stats.numericCount > 0 ? (
            <Stat label={messages.sheet.sum} value={format(stats.sum)} />
          ) : null}
        </>
      ) : null}
    </>
  )
}

function StatusAction({
  onClick,
  children,
}: {
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-sm font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  )
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <span>
      {label}: <strong className="font-semibold text-foreground">{value}</strong>
    </span>
  )
}
