import { cn } from "@sixb/ui/lib/utils"

/** A row of mutually exclusive choices on a gray track, the chosen one raised. */
export function Segmented<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string
  readonly value: Value
  readonly options: readonly { readonly value: Value; readonly label: string }[]
  readonly onChange: (value: Value) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex gap-0.5 rounded-[10px] bg-muted p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-7 whitespace-nowrap rounded-lg px-[11px] text-[0.8125rem] text-muted-foreground transition-colors hover:text-foreground",
            option.value === value &&
              "bg-background font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_0.5px_rgba(0,0,0,0.08)]"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
