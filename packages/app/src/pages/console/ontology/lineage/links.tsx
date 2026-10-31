import { cn } from "@sixb/ui/lib/utils"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { useFormat } from "../../../section-ui"

/** A step's name, linking to its page when the reader may open it. */
export function MaybeLink({
  to,
  title,
  className,
  children,
}: {
  readonly to: string | null
  readonly title?: string
  readonly className?: string
  readonly children: ReactNode
}) {
  if (!to) {
    return (
      <span title={title} className={className}>
        {children}
      </span>
    )
  }

  return (
    <Link
      to={to}
      title={title}
      className={cn("underline-offset-2 hover:underline focus-visible:underline", className)}
    >
      {children}
    </Link>
  )
}

/** A moment relative to now, such as "2 hours ago", with the exact time on hover. */
export function RelativeTime({ value }: { readonly value: string }) {
  const format = useFormat()
  return (
    <time dateTime={value} title={format.dateTime(value)}>
      {format.relative(value)}
    </time>
  )
}
