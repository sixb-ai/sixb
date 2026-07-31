import { isSixbApiError } from "@sixb/client"
import { EmptyState } from "@sixb/ui/components"
import { DatabaseZap } from "lucide-react"

/**
 * The runtime has no storage role behind this endpoint, so the data is not absent — it is not
 * being recorded at all. Treating the 501 as a failure paints a healthy runtime red; treating
 * it as an empty list claims "nothing has run yet" when nothing is being written down.
 *
 * Atlas-local rather than exported: a bare status check belongs in the unified error model.
 */
export function isUnconfiguredStorageError(value: unknown): boolean {
  return isSixbApiError(value) && value.status === 501
}

/**
 * Shown when a run-history endpoint answers 501: there is no history, and there will not be
 * until a storage role is configured.
 *
 * Not the "No runs" empty state, which claims the work has not happened yet, and not the error
 * state, which would send an operator hunting a fault that does not exist.
 */
export function UnrecordedHistoryState({
  what,
  className,
}: {
  /** What is not recorded, as a sentence subject: "Sync run history". */
  what: string
  className?: string
}) {
  return (
    <EmptyState
      icon={<DatabaseZap className="h-10 w-10" />}
      title={`${what} is not recorded`}
      description="This runtime has no storage configured for it. Add the storage provider to keep a history."
      className={className ?? "py-8"}
    />
  )
}
