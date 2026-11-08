/**
 * Placeholders the Console's pages share while they load, each the size of what replaces it. A
 * line of text is a `SkeletonText` inside an element with the real text's size; these are the
 * marks and controls of a fixed size.
 */
import { Card } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight } from "lucide-react"
import { SkeletonText, Stats } from "../section-ui"

/** A placeholder of a fixed size, such as an icon tile, a button or a select. */
export function SkeletonBlock({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("block shrink-0 animate-pulse rounded-md bg-muted", className)}
    />
  )
}

/** Where a `Pill` goes, such as a run's status. */
export function PillSkeleton() {
  return <SkeletonBlock className="h-5 w-20 rounded-full" />
}

/** What ends a `PanelRow`: its status pill, and the chevron of a row that opens a page. */
export function TrailingSkeleton({
  pill = true,
  chevron = false,
}: {
  readonly pill?: boolean
  readonly chevron?: boolean
}) {
  return (
    <>
      {pill ? <PillSkeleton /> : null}
      {chevron ? <ChevronRight aria-hidden className="size-4 text-muted-foreground/60" /> : null}
    </>
  )
}

/**
 * A detail page's facts under its title while it loads: a status pill and a line of text. A line
 * in a flex row sits in its own span, which keeps the text's line height.
 */
export function MetaSkeleton({ pill = true }: { readonly pill?: boolean }) {
  return (
    <>
      {pill ? <PillSkeleton /> : null}
      <span>
        <SkeletonText className="w-48" />
      </span>
    </>
  )
}

/** A detail page's `Stats` with their labels, before their values arrive. */
export function StatsSkeleton({ labels }: { readonly labels: readonly string[] }) {
  return (
    <Stats items={labels.map((label) => ({ label, value: <SkeletonText className="w-16" /> }))} />
  )
}

/** A page's count beside its title while it loads, such as "12 rules". */
export function CountSkeleton() {
  return (
    <span>
      <SkeletonText className="w-16" />
    </span>
  )
}

/**
 * A card of a catalog while it loads, shaped like `WorkflowCard` and `ActionCard`: a mark, a name
 * and a line of counts, then a footer with the latest run and its status.
 */
export function CardSkeleton() {
  return (
    <Card aria-hidden className="gap-0 overflow-hidden p-0">
      <div className="flex min-w-0 items-center gap-3 p-4">
        <SkeletonBlock className="size-9 rounded-lg" />
        <div className="min-w-0 flex-1">
          <div className="text-sm">
            <SkeletonText className="h-3 w-36" />
          </div>
          <p className="mt-1 text-sm">
            <SkeletonText className="w-56 bg-muted/70" />
          </p>
        </div>
      </div>
      <div className="flex min-h-14 items-center justify-between gap-3 border-t border-border px-4 py-3">
        <p className="text-sm">
          <SkeletonText className="w-40 bg-muted/70" />
        </p>
        <PillSkeleton />
      </div>
    </Card>
  )
}
