import { Input } from "@sixb/ui/components"
import { Search } from "lucide-react"
import type { ReactNode } from "react"

/**
 * A collection page's search and controls, which stay at the top as the list scrolls. The page's
 * title and count are in its header.
 */
export function CollectionToolbar({
  search,
  actions,
}: {
  search?: {
    value: string
    placeholder: string
    disabled?: boolean
    onChange: (value: string) => void
  }
  actions?: ReactNode
}) {
  return (
    <div className="sticky top-0 z-30 bg-background/92 py-2 backdrop-blur-xl supports-[backdrop-filter]:bg-background/82">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
        {search ? <CollectionSearchInput {...search} /> : null}
        {actions ? (
          <div className="flex shrink-0 items-center gap-2 [&_[data-slot=toggle-group]]:h-9">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
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
        className="h-9 bg-card pl-9 shadow-none"
        autoComplete="off"
      />
    </div>
  )
}
