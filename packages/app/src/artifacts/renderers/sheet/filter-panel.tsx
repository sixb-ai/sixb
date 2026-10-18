import { Button, Checkbox, NativeSelect, NativeSelectOption } from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { ArrowDown, ArrowUp } from "lucide-react"
import { useId, useMemo, useState } from "react"
import { type ArtifactMessages, useArtifactMessages } from "../../messages"
import {
  type ColumnFilter,
  distinctValues,
  FILTER_OPERATORS,
  type FilterOperator,
  filtersByCondition,
} from "./filter"
import type { FormattedCell } from "./format"
import type { SheetModel } from "./model"
import type { SortDirection } from "./selection"

/**
 * What a column's filter keeps, set as the reader changes it: a checklist of its values, or, for
 * numbers and dates, a condition. Each change applies at once. Given `onSort`, it opens with the
 * column's sort, as a spreadsheet's filter button does.
 */
export function FilterPanel({
  model,
  column,
  format,
  filter,
  onChange,
  sort,
  onSort,
}: {
  readonly model: SheetModel
  readonly column: number
  readonly format: (value: string) => FormattedCell
  readonly filter: ColumnFilter | undefined
  /** Null takes the filter off. */
  readonly onChange: (filter: ColumnFilter | null) => void
  readonly sort?: SortDirection | null
  readonly onSort?: (direction: SortDirection | null) => void
}) {
  const messages = useArtifactMessages().sheet
  const entry = model.columns[column]
  if (!entry) return null
  return (
    <div className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-3 text-[13px]">
      {onSort ? (
        <div className="-mx-1 flex flex-col border-b border-border/70 pb-2">
          {(["ascending", "descending"] as const).map((direction) => {
            const Icon = direction === "ascending" ? ArrowUp : ArrowDown
            const active = sort === direction
            return (
              <button
                key={direction}
                type="button"
                aria-pressed={active}
                onClick={() => onSort(active ? null : direction)}
                className={cn(
                  "flex h-8 items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                  active && "font-medium text-primary"
                )}
              >
                <Icon className="size-3.5" aria-hidden="true" />
                {direction === "ascending" ? messages.sortAscending : messages.sortDescending}
              </button>
            )
          })}
        </div>
      ) : null}
      <p className="truncate font-medium">{messages.filterColumn(entry.name)}</p>
      {filtersByCondition(entry) ? (
        <ConditionFilter
          date={entry.format.type === "date"}
          filter={filter?.kind === "condition" ? filter : undefined}
          onChange={onChange}
          messages={messages}
        />
      ) : (
        <ValuesFilter
          model={model}
          column={column}
          format={format}
          excluded={filter?.kind === "values" ? filter.excluded : []}
          onChange={onChange}
          messages={messages}
        />
      )}
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        disabled={!filter}
        onClick={() => onChange(null)}
      >
        {messages.clearFilter}
      </Button>
    </div>
  )
}

function ValuesFilter({
  model,
  column,
  format,
  excluded,
  onChange,
  messages,
}: {
  readonly model: SheetModel
  readonly column: number
  readonly format: (value: string) => FormattedCell
  readonly excluded: readonly string[]
  readonly onChange: (filter: ColumnFilter) => void
  readonly messages: ArtifactMessages["sheet"]
}) {
  const locale = useLocale()
  const [search, setSearch] = useState("")
  const { values, more } = useMemo(() => distinctValues(model, column), [model, column])
  const hiding = new Set(excluded)
  const label = (value: string) => (value ? format(value).text : messages.emptyValue)
  const needle = search.trim().toLowerCase()
  const shown = needle
    ? values.filter(({ value }) => label(value).toLowerCase().includes(needle))
    : values
  const set = (next: Set<string>) => onChange({ kind: "values", excluded: [...next] })

  return (
    <>
      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={messages.searchValues}
        aria-label={messages.searchValues}
        className="h-8 rounded-md border border-border bg-background px-2 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex gap-3 text-xs">
        <button
          type="button"
          className="font-medium text-primary underline-offset-2 hover:underline"
          onClick={() => {
            const next = new Set(hiding)
            for (const { value } of shown) next.delete(value)
            set(next)
          }}
        >
          {messages.selectAll}
        </button>
        <button
          type="button"
          className="font-medium text-primary underline-offset-2 hover:underline"
          onClick={() => {
            const next = new Set(hiding)
            for (const { value } of shown) next.add(value)
            set(next)
          }}
        >
          {messages.selectNone}
        </button>
      </div>
      <ul className="-mx-1 flex max-h-64 flex-col overflow-y-auto" aria-label={messages.values}>
        {shown.map(({ value, count }) => (
          <li key={value}>
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-muted">
              <Checkbox
                checked={!hiding.has(value)}
                onCheckedChange={(checked) => {
                  const next = new Set(hiding)
                  if (checked === true) next.delete(value)
                  else next.add(value)
                  set(next)
                }}
              />
              <span className={value ? "min-w-0 flex-1 truncate" : "flex-1 italic"}>
                {label(value)}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {count.toLocaleString(locale)}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {more > 0 ? (
        <p className="text-xs text-muted-foreground">{messages.moreValues(more)}</p>
      ) : null}
    </>
  )
}

function ConditionFilter({
  date,
  filter,
  onChange,
  messages,
}: {
  readonly date: boolean
  readonly filter: Extract<ColumnFilter, { kind: "condition" }> | undefined
  readonly onChange: (filter: ColumnFilter) => void
  readonly messages: ArtifactMessages["sheet"]
}) {
  const id = useId()
  // The panel keeps what the reader is typing: a condition without its value keeps every row,
  // so the view holds no filter until it has one.
  const [draft, setDraft] = useState<Extract<ColumnFilter, { kind: "condition" }>>(
    filter ?? { kind: "condition", op: date ? "gte" : "gt" }
  )
  const update = (change: Partial<typeof draft>) => {
    const next = { ...draft, ...change }
    setDraft(next)
    onChange(next)
  }
  const operators = date ? messages.dateOperators : messages.operators
  const needsValue = draft.op !== "empty" && draft.op !== "notEmpty"
  const input = (field: "value" | "to", label: string) => (
    <input
      id={`${id}-${field}`}
      type={date ? "date" : "text"}
      inputMode={date ? undefined : "decimal"}
      value={draft[field] ?? ""}
      onChange={(event) =>
        update(field === "value" ? { value: event.target.value } : { to: event.target.value })
      }
      aria-label={label}
      className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  )
  return (
    <div className="flex flex-col gap-2">
      <NativeSelect
        size="sm"
        value={draft.op}
        onChange={(event) => update({ op: event.target.value as FilterOperator })}
        aria-label={messages.condition}
        className="w-full"
      >
        {FILTER_OPERATORS.map((op) => (
          <NativeSelectOption key={op} value={op}>
            {operators[op]}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {needsValue ? (
        <div className="flex items-center gap-2">
          {input("value", messages.conditionValue)}
          {draft.op === "between" ? (
            <>
              <span className="text-muted-foreground">{messages.and}</span>
              {input("to", messages.conditionTo)}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
