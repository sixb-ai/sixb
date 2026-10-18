import {
  ContextMenuItem,
  ContextMenuSeparator,
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
import { type ReactNode, useRef } from "react"
import { type ArtifactMessages, useArtifactMessages } from "../../messages"
import type { SortDirection } from "./selection"

/**
 * What a column's menu can do: sort the sheet by it, filter it, fit it to its values, freeze the
 * columns up to it, or hide it. An action the reader can't take is absent: freezing columns wider
 * than most of the grid, or hiding the last column shown.
 */
export interface ColumnActions {
  readonly sort: SortDirection | null
  readonly onSort: (direction: SortDirection | null) => void
  /** Turns filter mode on and opens the column's filter. */
  readonly onFilter: () => void
  readonly onFit: () => void
  /** Whether the column is one of the frozen ones. */
  readonly frozen: boolean
  readonly onFreeze?: () => void
  readonly onUnfreeze?: () => void
  readonly onHide?: () => void
}

/** The parts a menu is drawn with: a dropdown's from a column letter, a context menu's on right-click. */
export interface MenuParts {
  readonly Item: typeof DropdownMenuItem | typeof ContextMenuItem
  readonly Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator
}

export const DROPDOWN_PARTS: MenuParts = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
}
export const CONTEXT_PARTS: MenuParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator }

/** A column's actions as items of either kind of menu. */
export function ColumnMenuItems({
  actions,
  parts: { Item, Separator },
  messages,
}: {
  readonly actions: ColumnActions
  readonly parts: MenuParts
  readonly messages: ArtifactMessages["sheet"]
}): ReactNode {
  const { sort } = actions
  return (
    <>
      <Item disabled={sort === "ascending"} onSelect={() => actions.onSort("ascending")}>
        <ArrowUp aria-hidden="true" />
        {messages.sortAscending}
      </Item>
      <Item disabled={sort === "descending"} onSelect={() => actions.onSort("descending")}>
        <ArrowDown aria-hidden="true" />
        {messages.sortDescending}
      </Item>
      {sort ? (
        <Item onSelect={() => actions.onSort(null)}>
          <X aria-hidden="true" />
          {messages.clearSort}
        </Item>
      ) : null}
      <Item onSelect={actions.onFilter}>
        <ListFilter aria-hidden="true" />
        {messages.filter}
      </Item>
      <Separator />
      <Item onSelect={actions.onFit}>
        <MoveHorizontal aria-hidden="true" />
        {messages.fitWidth}
      </Item>
      {actions.onFreeze && !actions.frozen ? (
        <Item onSelect={actions.onFreeze}>
          <Pin aria-hidden="true" />
          {messages.freezeHere}
        </Item>
      ) : null}
      {actions.onUnfreeze ? (
        <Item onSelect={actions.onUnfreeze}>
          <PinOff aria-hidden="true" />
          {messages.unfreeze}
        </Item>
      ) : null}
      {actions.onHide ? (
        <Item onSelect={actions.onHide}>
          <EyeOff aria-hidden="true" />
          {messages.hideColumn}
        </Item>
      ) : null}
    </>
  )
}

/**
 * A column's menu from a chevron on its letter, which shows on hover, on focus, and always on a
 * touch screen. Choosing Filter opens the column's filter, which keeps focus as the menu closes.
 */
export function ColumnMenu({
  name,
  actions,
}: {
  readonly name: string
  readonly actions: ColumnActions
}) {
  const messages = useArtifactMessages().sheet
  const filtering = useRef(false)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={messages.columnMenu(name)}
        title={messages.columnMenu(name)}
        className="absolute top-1/2 right-1.5 flex size-4 -translate-y-1/2 items-center justify-center rounded-[3px] text-muted-foreground opacity-0 transition-opacity outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:opacity-100 [[data-letter]:hover_&]:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <ChevronDown className="size-3" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-52"
        onCloseAutoFocus={(event) => {
          // Focus going back to the menu's button would close the filter it opened.
          if (filtering.current) event.preventDefault()
          filtering.current = false
        }}
      >
        <ColumnMenuItems
          actions={{
            ...actions,
            onFilter: () => {
              filtering.current = true
              actions.onFilter()
            },
          }}
          parts={DROPDOWN_PARTS}
          messages={messages}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
