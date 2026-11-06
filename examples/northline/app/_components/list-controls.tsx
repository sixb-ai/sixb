import { cn } from "@sixb/ui/lib/utils"
import { ArrowUpDown, Search } from "lucide-react"

type Option<T extends string> = readonly [T, string]

/** The quiet search field that sits in a list page's header. */
export function SearchField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  placeholder: string
  onChange(value: string): void
}) {
  return (
    <label className="relative block w-64 min-w-0 shrink max-sm:w-auto max-sm:flex-1">
      <span className="sr-only">{label}</span>
      <Search
        className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
        strokeWidth={1.8}
      />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-10 w-full rounded-[10px] bg-black/[0.045] pr-3 pl-10 text-[14px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring dark:bg-white/[0.07]"
      />
    </label>
  )
}

/**
 * A sort order as a native select, styled to sit beside `SearchField`. On a phone it shrinks to its
 * icon so the search keeps the row; tapping it still opens the system picker.
 */
export function SortSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly Option<T>[]
  onChange(value: NoInfer<T>): void
}) {
  return (
    <label className="relative block shrink-0">
      <span className="sr-only">{label}</span>
      <ArrowUpDown
        className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground max-sm:left-3 max-sm:text-foreground/70"
        strokeWidth={1.8}
      />
      <select
        value={value}
        onChange={(event) => {
          const option = options.find(([id]) => id === event.target.value)
          if (option) onChange(option[0])
        }}
        className="h-10 max-w-[13rem] appearance-none truncate rounded-[10px] bg-black/[0.045] pr-4 pl-10 text-[14px] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:w-10 max-sm:p-0 max-sm:text-transparent dark:bg-white/[0.07]"
      >
        {options.map(([id, text]) => (
          <option key={id} value={id}>
            {text}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Saved views as pills, each with the number of rows it holds; one scrolling row on a phone. */
export function ViewPills<T extends string>({
  label,
  views,
  value,
  counts,
  onChange,
}: {
  label: string
  views: readonly Option<T>[]
  value: T
  counts: Readonly<Record<string, number>>
  onChange(view: NoInfer<T>): void
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="-mx-1 flex flex-wrap gap-1.5 max-sm:-mx-5 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:px-5 max-sm:[scrollbar-width:none]"
    >
      {views.map(([id, text]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          onClick={() => onChange(id)}
          className={cn(
            "inline-flex h-9 shrink-0 items-center gap-2 rounded-full px-4 text-[14px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            value === id
              ? "bg-foreground text-background"
              : "bg-black/[0.045] text-foreground/80 hover:bg-black/[0.07] dark:bg-white/[0.07]"
          )}
        >
          {text}
          <span
            className={cn(
              "text-[12.5px] tabular-nums",
              value === id ? "text-background/70" : "text-muted-foreground"
            )}
          >
            {counts[id] ?? 0}
          </span>
        </button>
      ))}
    </div>
  )
}
