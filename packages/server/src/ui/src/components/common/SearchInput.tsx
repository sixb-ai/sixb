import { cn } from "../../lib/utils"

interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  iconClassName?: string
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search...",
  className,
  iconClassName = "text-muted-foreground",
}: SearchInputProps) {
  return (
    <div className={cn("relative", className)}>
      {/* Search icon */}
      <svg
        className={cn(
          "absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none z-10",
          iconClassName
        )}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
        />
      </svg>

      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "w-full h-9 pl-9 pr-8 text-sm",
          "rounded-lg border border-border bg-card/50 backdrop-blur-sm",
          "text-foreground placeholder:text-muted-foreground/70",
          "focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500/50",
          "transition-all duration-200"
        )}
      />

      {/* Clear button */}
      {value && (
        <button
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      )}
    </div>
  )
}
