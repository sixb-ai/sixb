import { Skeleton } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight } from "lucide-react"
import type { PropsWithChildren, ReactNode } from "react"
import { Link } from "react-router-dom"

// Widgets snap to a 4-column grid: small is 1×1, medium 2×1, large 2×2. On narrow screens the
// grid has two columns and every size spans both.
const sizeClassNames = {
  small: "col-span-2 @md:col-span-1",
  medium: "col-span-2",
  large: "col-span-2 row-span-2",
} as const

export type WidgetSize = keyof typeof sizeClassNames

/**
 * A home widget. The whole card opens `to`; controls inside it sit above the link with
 * `relative z-20`.
 */
export function Widget({
  to,
  label,
  title,
  meta,
  size,
  className,
  children,
}: PropsWithChildren<{
  to: string
  label: string
  title: string
  meta?: ReactNode
  size: WidgetSize
  className?: string
}>) {
  return (
    <section
      className={cn(
        "group relative isolate flex min-w-0 flex-col overflow-hidden rounded-[22px] bg-card px-[22px] py-5 text-card-foreground shadow-[0_0_0_1px_rgb(0_0_0/0.04),0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.1)] transition-[translate,scale,box-shadow] duration-300 ease-out hover:shadow-[0_0_0_1px_rgb(0_0_0/0.05),0_2px_4px_rgb(0_0_0/0.04),0_16px_36px_-12px_rgb(0_0_0/0.18)] motion-safe:hover:-translate-y-0.5 motion-safe:active:scale-[0.99] motion-safe:active:duration-100 dark:shadow-none dark:ring-1 dark:ring-border dark:hover:ring-foreground/25",
        sizeClassNames[size],
        className
      )}
    >
      <Link
        to={to}
        aria-label={label}
        className="absolute inset-0 z-10 rounded-[22px] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      />
      <header className="flex min-w-0 items-center justify-between gap-3">
        <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
        <p className="flex shrink-0 items-center gap-0.5 text-[13px] text-muted-foreground">
          {meta}
          <ChevronRight
            className="size-3.5 transition-[translate,color] duration-300 group-hover:translate-x-0.5 group-hover:text-foreground"
            aria-hidden="true"
          />
        </p>
      </header>
      {children}
    </section>
  )
}

/** The widget's headline number, with what it means and an optional supporting fact. */
export function WidgetMetric({
  value,
  label,
  aside,
  valueClassName = "",
}: {
  value: ReactNode
  label: ReactNode
  aside?: ReactNode
  valueClassName?: string
}) {
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <span
        className={cn(
          "text-[40px] leading-none font-semibold tracking-[-0.035em] tabular-nums",
          valueClassName
        )}
      >
        {value}
      </span>
      <span className="text-[15px] font-medium text-muted-foreground">{label}</span>
      {aside ? (
        <span className="ml-auto flex items-center gap-1.5 text-[13px] text-muted-foreground">
          {aside}
        </span>
      ) : null}
    </p>
  )
}

export interface BreakdownSegment {
  readonly key: string
  readonly label: string
  readonly count: number
  readonly className: string
}

/** A segmented bar with a count under each segment; four columns so rows of widgets line up. */
export function WidgetBreakdown({
  segments,
  label,
}: {
  segments: readonly BreakdownSegment[]
  label: string
}) {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0)
  return (
    <>
      <div
        role="img"
        aria-label={label}
        className={cn("nl-bar mt-4 flex h-2 gap-[3px]", total === 0 && "rounded-full bg-muted")}
      >
        {segments.map((segment) =>
          segment.count > 0 ? (
            <span
              key={segment.key}
              className={cn("min-w-0 basis-0 rounded-full", segment.className)}
              style={{ flexGrow: segment.count }}
            />
          ) : null
        )}
      </div>
      <dl className="mt-3.5 grid grid-cols-4 gap-2">
        {segments.map((segment) => (
          <div key={segment.key} className="flex min-w-0 flex-col-reverse gap-0.5">
            <dt className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span
                aria-hidden="true"
                className={cn(
                  "size-[7px] shrink-0 rounded-full",
                  segment.count > 0
                    ? segment.className
                    : "ring-[1.5px] ring-muted-foreground/50 ring-inset"
                )}
              />
              <span className="truncate">{segment.label}</span>
            </dt>
            <dd
              className={cn(
                "text-[17px] font-semibold tracking-[-0.01em] tabular-nums",
                segment.count === 0 && "text-muted-foreground"
              )}
            >
              {segment.count}
            </dd>
          </div>
        ))}
      </dl>
    </>
  )
}

/** Loading and error states for a widget body, anchored to the bottom like the content it replaces. */
export function WidgetState({
  loading,
  error,
  label,
  children,
}: PropsWithChildren<{ loading: boolean; error: boolean; label: string }>) {
  if (loading) {
    return (
      <div aria-label={`Loading ${label}`} className="mt-auto grid gap-3 pt-4">
        <Skeleton className="h-10 w-28" />
        <Skeleton className="h-2 w-full rounded-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    )
  }
  if (error) {
    return <p className="mt-auto pt-4 text-[13px] text-muted-foreground">Couldn’t load {label}.</p>
  }
  return children
}
