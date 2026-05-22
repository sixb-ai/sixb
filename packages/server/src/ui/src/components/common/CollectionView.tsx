import type { ReactNode } from "react"
import { cn } from "../../lib/utils"
import { Badge } from "../ui/badge"

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
        <Badge variant="secondary" className="bg-accent/70 text-xs">
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
    <div className="flex items-center gap-0.5 rounded-lg border border-border/50 bg-card/50 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
            value === option.value
              ? "bg-foreground/10 text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
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
    <article
      onClick={onClick}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors",
        active
          ? "border-emerald-500/40 bg-emerald-500/5"
          : "border-border/50 bg-card hover:bg-accent/25",
        className
      )}
    >
      {children}
    </article>
  )
}

export function CollectionTable({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border/60">
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  )
}
