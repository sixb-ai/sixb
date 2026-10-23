import { Spinner } from "@sixb/ui/components"
import { FileWarning } from "lucide-react"
import type { ReactNode } from "react"

/** A centered message in place of content that could not or should not render. */
export function ViewerNotice({
  title,
  description,
  icon,
  action,
}: {
  readonly title: string
  readonly description?: string
  readonly icon?: ReactNode
  readonly action?: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
      <div className="flex max-w-sm flex-col items-center gap-2">
        {icon ?? <FileWarning className="size-8 text-muted-foreground" aria-hidden="true" />}
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? (
          <p className="text-sm break-words text-muted-foreground">{description}</p>
        ) : null}
        {action ? <div className="pt-2">{action}</div> : null}
      </div>
    </div>
  )
}

export function ViewerLoading({ label }: { readonly label: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center" aria-busy="true" role="status">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        {label}
      </div>
    </div>
  )
}
