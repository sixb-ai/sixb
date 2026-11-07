import { Skeleton } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight } from "lucide-react"
import type { PropsWithChildren, ReactNode } from "react"
import { Link } from "react-router-dom"

/** A home tile. The whole card opens `to`. */
export function Widget({
  to,
  label,
  title,
  children,
}: PropsWithChildren<{ to: string; label: string; title: string }>) {
  return (
    <section className="group relative isolate flex min-h-[7.5rem] min-w-0 flex-col rounded-[18px] bg-card px-4 py-3.5 text-card-foreground shadow-[0_0_0_1px_rgb(0_0_0/0.04),0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.1)] transition-[translate,scale,box-shadow] duration-300 ease-out hover:shadow-[0_0_0_1px_rgb(0_0_0/0.05),0_2px_4px_rgb(0_0_0/0.04),0_16px_36px_-12px_rgb(0_0_0/0.18)] motion-safe:hover:-translate-y-0.5 motion-safe:active:scale-[0.99] motion-safe:active:duration-100 dark:shadow-none dark:ring-1 dark:ring-border dark:hover:ring-foreground/25">
      <Link
        to={to}
        aria-label={label}
        className="absolute inset-0 z-10 rounded-[18px] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      />
      <header className="flex min-w-0 items-center justify-between gap-2">
        <h2 className="truncate text-[13.5px] font-semibold tracking-[-0.01em]">{title}</h2>
        <ChevronRight
          className="size-3.5 shrink-0 text-muted-foreground transition-[translate,color] duration-300 group-hover:translate-x-0.5 group-hover:text-foreground"
          aria-hidden="true"
        />
      </header>
      {children}
    </section>
  )
}

/** The tile's number, anchored to the bottom, with one line of context under it. */
export function WidgetMetric({
  value,
  detail,
  valueClassName = "",
}: {
  value: ReactNode
  detail?: ReactNode
  valueClassName?: string
}) {
  return (
    <div className="mt-auto flex min-w-0 flex-col gap-1 pt-3">
      <span
        className={cn(
          "text-[32px] leading-none font-semibold tracking-[-0.035em] tabular-nums",
          valueClassName
        )}
      >
        {value}
      </span>
      <span className="truncate text-[12.5px] text-muted-foreground">{detail ?? " "}</span>
    </div>
  )
}

/** Loading and error states for a tile body, anchored to the bottom like the number it replaces. */
export function WidgetState({
  loading,
  error,
  label,
  children,
}: PropsWithChildren<{ loading: boolean; error: boolean; label: string }>) {
  if (loading) {
    return (
      <div aria-label={`Loading ${label}`} className="mt-auto grid gap-2 pt-3">
        <Skeleton className="h-8 w-12" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    )
  }
  if (error) {
    return (
      <p className="mt-auto pt-3 text-[12.5px] text-muted-foreground">Couldn’t load {label}.</p>
    )
  }
  return children
}
