import type { SixbErrorCode } from "../errors/types"
import type { QueueJob } from "../queues"
import type { ConfirmRunExecutionInput, RunExecution } from "../storage"
import type { QueueDelivery } from "./queue-delivery"

interface LeasedRunStorage {
  getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<{ readonly status: string; readonly execution?: RunExecution } | null>
  confirmExecutionOwnership(input: ConfirmRunExecutionInput): Promise<unknown>
}

/**
 * The queue stays the only source of ownership timing: each renewal it confirms is copied onto the
 * run, so that another delivery can tell a live holder from a dead one. Returns the stop function.
 */
export function projectRunLease<TJob extends QueueJob, TFailureCode extends SixbErrorCode>(
  delivery: QueueDelivery<TJob, TFailureCode>,
  runs: LeasedRunStorage,
  run: { readonly projectId: string; readonly id: string; readonly executionToken: string }
): () => void {
  return delivery.onLeaseRenewed((renewed) => {
    void confirmLease(runs, run, renewed.leaseExpiresAt)
  })
}

async function confirmLease(
  runs: LeasedRunStorage,
  run: { readonly projectId: string; readonly id: string; readonly executionToken: string },
  queueLeaseExpiresAt: string
): Promise<void> {
  try {
    await runs.confirmExecutionOwnership({
      ...run,
      queueLeaseExpiresAt: new Date(queueLeaseExpiresAt),
    })
  } catch (error) {
    // A run that ended or moved on refuses the confirmation, which is nothing to report.
    const current = await runs.getById(run).catch(() => null)
    const holder = current?.execution?.token ?? run.executionToken
    if (current?.status === "running" && holder === run.executionToken) {
      console.error(`[SixbQueueWorker] Could not project the lease of run '${run.id}'.`, error)
    }
  }
}
