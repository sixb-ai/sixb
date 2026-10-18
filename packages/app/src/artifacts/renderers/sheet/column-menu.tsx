import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sixb/ui/components"
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  EyeOff,
  ListFilter,
  MoveHorizontal,
  Pin,
  PinOff,
  X,
} from "lucide-react"
import { useRef } from "react"
import { useArtifactMessages } from "../../messages"
import type { SortDirection } from "./selection"

/**
 * A column's menu, from its header: sort the sheet by it, filter it, fit it to its values, freeze
 * the columns up to it, or hide it. What the reader can't do here is left out: freezing columns
 * wider than most of the grid, or hiding the last column shown.
 */
export function ColumnMenu({
  name,
  sort,
  onSort,
  onFilter,
  onFit,
  frozen,
  onFreeze,
  onUnfreeze,
  onHide,
}: {
  readonly name: string
  readonly sort: SortDirection | null
  readonly onSort: (direction: SortDirection | null) => void
  /** Opens the column's filter, which takes focus from the menu as it closes. */
  readonly onFilter: () => void
  readonly onFit: () => void
  /** Whether the column is one of the frozen ones. */
  readonly frozen: boolean
  readonly onFreeze?: () => void
  readonly onUnfreeze?: () => void
  readonly onHide?: () => void
}) {
  const messages = useArtifactMessages().sheet
  const filtering = useRef(false)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={messages.columnMenu(name)}
        title={messages.columnMenu(name)}
        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity outline-none hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:opacity-100 [[role=columnheader]:hover_&]:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-52"
        onCloseAutoFocus={(event) => {
          // Focus going back to the menu's button would close the filter it opened.
          if (filtering.current) event.preventDefault()
          filtering.current = false
        }}
      >
        <DropdownMenuItem disabled={sort === "ascending"} onSelect={() => onSort("ascending")}>
          <ArrowUp aria-hidden="true" />
          {messages.sortAscending}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={sort === "descending"} onSelect={() => onSort("descending")}>
          <ArrowDown aria-hidden="true" />
          {messages.sortDescending}
        </DropdownMenuItem>
        {sort ? (
          <DropdownMenuItem onSelect={() => onSort(null)}>
            <X aria-hidden="true" />
            {messages.clearSort}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={() => {
            filtering.current = true
            onFilter()
          }}
        >
          <ListFilter aria-hidden="true" />
          {messages.filter}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onFit}>
          <MoveHorizontal aria-hidden="true" />
          {messages.fitWidth}
        </DropdownMenuItem>
        {onFreeze && !frozen ? (
          <DropdownMenuItem onSelect={onFreeze}>
            <Pin aria-hidden="true" />
            {messages.freezeHere}
          </DropdownMenuItem>
        ) : null}
        {onUnfreeze ? (
          <DropdownMenuItem onSelect={onUnfreeze}>
            <PinOff aria-hidden="true" />
            {messages.unfreeze}
          </DropdownMenuItem>
        ) : null}
        {onHide ? (
          <DropdownMenuItem onSelect={onHide}>
            <EyeOff aria-hidden="true" />
            {messages.hideColumn}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
