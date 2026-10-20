import type { ReactNode } from "react"

/**
 * A row's facts. Each separator leads its fact, and the list is shifted left by one separator
 * under a clip, so the separator of a fact that wraps to the start of a line is cut away: no line
 * starts or ends on one.
 */
export function MetaItems({ items }: { readonly items: readonly ReactNode[] }) {
  return (
    <span className="block w-full min-w-0 overflow-hidden">
      <span className="-ml-4 flex flex-wrap items-center">
        {items.map((item, index) => (
          <span key={index} className="inline-flex min-w-0 items-center">
            <span aria-hidden className="w-4 shrink-0 text-center text-muted-foreground/50">
              ·
            </span>
            <span className="truncate">{item}</span>
          </span>
        ))}
      </span>
    </span>
  )
}
