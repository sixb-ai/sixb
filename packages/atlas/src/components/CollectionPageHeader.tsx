import { Input } from "@sixb/ui/components"
import { Search } from "lucide-react"
import type { ReactNode } from "react"

export function CollectionPageHeader({
  title,
  count,
  singularLabel,
  search,
  actions,
}: {
  title: string
  count: number
  singularLabel: string
  search?: {
    value: string
    placeholder: string
    onChange: (value: string) => void
  }
  actions?: ReactNode
}) {
  return (
    <>
      <CollectionPageTitle title={title} count={count} singularLabel={singularLabel} />

      {search || actions ? (
        <div className="sticky top-0 z-30 mt-3 bg-background/92 py-2 backdrop-blur-xl supports-[backdrop-filter]:bg-background/82">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
            {search ? <CollectionSearchInput {...search} /> : null}
            {actions ? (
              <div className="flex shrink-0 items-center gap-2 [&_[data-slot=toggle-group]]:h-9">
                {actions}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  )
}

export function CollectionPageTitle({
  title,
  count,
  singularLabel,
}: {
  title: string
  count: number
  singularLabel: string
}) {
  return (
    <header className="flex flex-col gap-3 pb-2 sm:flex-row sm:items-center sm:justify-between">
      <h1 className="text-2xl font-semibold tracking-[-0.04em] text-foreground sm:text-[2rem]">
        {title}
      </h1>
      <p className="text-xs text-muted-foreground">
        {count.toLocaleString()} {singularLabel}
        {count === 1 ? "" : "s"}
      </p>
    </header>
  )
}

export function CollectionSearchInput({
  value,
  placeholder,
  disabled,
  onChange,
}: {
  value: string
  placeholder: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
        className="h-9 bg-white pl-9 shadow-none focus-visible:bg-white dark:bg-card dark:focus-visible:bg-card"
        autoComplete="off"
      />
    </div>
  )
}
