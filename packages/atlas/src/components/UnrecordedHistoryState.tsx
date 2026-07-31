import { isSixbApiError } from "@sixb/client"
import { EmptyState } from "@sixb/ui/components"
import { DatabaseZap } from "lucide-react"

/**
 * The runtime has no storage role behind this endpoint, so the data is not absent —
 * it is not being recorded at all.
 *
 * Run-history endpoints answer 501 when their storage role was never configured.
 * Treating that as an ordinary failure paints a healthy runtime red; treating it as
 * an empty list claims "nothing has run yet" when nothing is being written down.
 *
 * Deliberately Atlas-local rather than exported from `@sixb/client`: an app author
 * who hits this 501 caused it in their own `createSixb()`, and a bare status check
 * belongs in the unified error model, not in a one-off public predicate.
 */
export function isUnconfiguredStorageError(value: unknown): boolean {
  return isSixbApiError(value) && value.status === 501
}

/**
 * Shown when a run-history endpoint answers 501: the runtime has no storage role
 * for it, so there is no history to show and there never will be until one is
 * configured.
 *
 * Deliberately not the "No runs" empty state — that one says the work has not
 * happened yet, which is a claim this runtime cannot make. Deliberately not the
 * error state either: nothing failed, and a red banner would send an operator
 * hunting a fault that does not exist.
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
