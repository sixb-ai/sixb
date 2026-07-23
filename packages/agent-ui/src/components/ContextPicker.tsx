import { type AgentContextInput, agentContextIdentity } from "@sixb/core/agents/context"
import { Spinner } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Search } from "lucide-react"

interface ContextPickerResult {
  readonly context: AgentContextInput
  readonly label: string
}

interface ContextPickerProps {
  readonly open: boolean
  readonly query: string
  readonly loading: boolean
  readonly results: readonly ContextPickerResult[]
  readonly activeIndex: number
  readonly onActiveIndexChange: (index: number) => void
  readonly onSelect: (context: AgentContextInput) => void
}

export function ContextPicker({
  open,
  query,
  loading,
  results,
  activeIndex,
  onActiveIndexChange,
  onSelect,
}: ContextPickerProps) {
  const hasQuery = query.length > 0

  return (
    <div
      className={cn(
        "absolute inset-x-0 bottom-[calc(100%+0.5rem)] z-20 origin-bottom overflow-hidden rounded-2xl border border-border/80 bg-popover/95 p-1.5 text-popover-foreground shadow-xl shadow-black/5 backdrop-blur-xl",
        "transition-[opacity,transform,visibility] duration-150 ease-out motion-reduce:transition-none",
        open
          ? "visible translate-y-0 scale-100 opacity-100"
          : "pointer-events-none invisible translate-y-1 scale-[0.985] opacity-0"
      )}
      role="listbox"
      aria-label="Add context"
      aria-hidden={!open}
    >
      <div className="flex min-h-12 items-center gap-2 px-3 text-sm">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {hasQuery ? `Search results for “${query}”` : "Type after @ to search objects…"}
        </span>
        {loading && hasQuery ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
      </div>

      <div className="max-h-64 overflow-y-auto">
        {results.length > 0 ? (
          results.map((result, index) => (
            <button
              key={agentContextIdentity(result.context)}
              type="button"
              disabled={!open}
              role="option"
              aria-selected={index === activeIndex % results.length}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onActiveIndexChange(index)}
              onClick={() => onSelect(result.context)}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors duration-100",
                index === activeIndex % results.length
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-muted"
              )}
            >
              <span className="min-w-0 flex-1 truncate">{result.label}</span>
              <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {result.context.kind === "object" ? result.context.ref.objectTypeId : "Page"}
              </span>
            </button>
          ))
        ) : hasQuery ? (
          <p className="border-t border-border/60 px-3 py-3 text-sm text-muted-foreground">
            {loading ? "Searching…" : `No objects found for “${query}”`}
          </p>
        ) : null}
      </div>
    </div>
  )
}
