import type { Storage, WebhookRunExecution } from "../storage"
import { WEBHOOK_RUN_LEASE_MS } from "../storage/webhook-runs"

const WEBHOOK_RUN_RENEWAL_MS = 15_000

export interface HoldWebhookRunInput {
  readonly storage: Pick<Storage, "webhookRuns">
  readonly projectId: string
  readonly runId: string
  readonly execution: WebhookRunExecution
}

/**
 * Keep a run held for as long as its handler runs, however long that is: a retry must find it held,
 * and must not run the handler beside it. Returns the function that stops holding it.
 */
export function holdWebhookRun(input: HoldWebhookRunInput): () => void {
  const timer = setInterval(() => void renew(input, timer), WEBHOOK_RUN_RENEWAL_MS)
  timer.unref?.()

  return () => clearInterval(timer)
}

async function renew(
  input: HoldWebhookRunInput,
  timer: ReturnType<typeof setInterval>
): Promise<void> {
  try {
    const held = await input.storage.webhookRuns?.renewLease({
      projectId: input.projectId,
      id: input.runId,
      executionToken: input.execution.token,
      leaseExpiresAt: new Date(Date.now() + WEBHOOK_RUN_LEASE_MS),
    })

    if (held === false) clearInterval(timer)
  } catch (error) {
    console.error(`[Sixb] Could not renew the lease of Webhook run '${input.runId}'.`, error)
  }
}
