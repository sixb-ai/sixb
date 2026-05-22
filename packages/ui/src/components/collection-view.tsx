import type { ReactNode } from "react"
import { cn } from "../lib/utils"
import { Badge } from "./ui/badge"
import { Card } from "./ui/card"
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group"

export type CollectionViewOption<T extends string = string> = {
  readonly value: T
  readonly label: string
}

export function CollectionHeader({
  title,
  count,
  actions,
}: {
  title: string
  count: number
  actions?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </p>
        <Badge variant="secondary" className="text-xs">
          {count}
        </Badge>
      </div>
      {actions}
    </div>
  )
}

export function CollectionViewToggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: readonly CollectionViewOption<T>[]
  onChange: (value: T) => void
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as T)
      }}
      size="sm"
      spacing={1}
      className="rounded-md border border-border bg-muted p-0.5"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          aria-label={option.label}
          className="h-7 rounded-sm px-3 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:border data-[state=on]:border-border"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

export function CollectionCardGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{children}</div>
}

export function CollectionCardButton({
  children,
  onClick,
  active,
  className,
}: {
  children: ReactNode
  onClick: () => void
  active?: boolean
  className?: string
}) {
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onClick()
        }
      }}
      className={cn(
        "flex cursor-pointer flex-row items-center gap-3 px-3 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        active ? "border-foreground/40 bg-muted" : "hover:bg-muted",
        className
      )}
    >
      {children}
    </Card>
  )
}
