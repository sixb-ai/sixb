/**
 * A registered subscription with handles the registry can use to stop and
 * finalize it. The NATS-specific consumer lifecycle lives in the callers;
 * this registry only tracks active entries and orchestrates drain on close.
 */
export interface ActiveSubscription {
  /**
   * Stop delivering messages to the handler. Must be fast and idempotent —
   * it is called by the unsubscribe function returned to Broker callers.
   */
  stop(): void
  /**
   * Run to completion: wait for the consumer loop to exit and delete the
   * NATS-side ephemeral consumer. May throw; callers must handle.
   */
  drain(): Promise<void>
}

/**
 * Tracks active subscriptions so `NatsBroker.close()` can drain them.
 *
 * The `Broker.subscribe()` contract resolves to a synchronous unsubscribe
 * function. Individual unsubscribes stop message delivery immediately and
 * fire-and-forget the NATS-side consumer cleanup. During `close()`, all
 * still-registered subscriptions are drained awaited for deterministic
 * teardown.
 */
export class SubscriptionRegistry {
  private readonly active = new Set<ActiveSubscription>()

  /**
   * Register a new active subscription. Returns a synchronous unsubscribe
   * that stops delivery immediately and fires-and-forgets cleanup. Errors
   * from the async drain are logged with the [NatsBroker] prefix because
   * the unsubscribe function has no async error channel.
   */
  register(subscription: ActiveSubscription): () => void {
    this.active.add(subscription)
    return () => {
      if (!this.active.delete(subscription)) {
        return
      }
      subscription.stop()
      subscription.drain().catch((error: unknown) => {
        console.error("[NatsBroker] Failed to drain subscription during unsubscribe:", error)
      })
    }
  }

  /**
   * Await teardown of every still-active subscription. Called by
   * NatsBroker.close(). Stops all subscriptions first so drains can
   * proceed in parallel, then awaits them all and surfaces the first error
   * (if any) after the rest complete.
   */
  async drain(): Promise<void> {
    const subscriptions = [...this.active]
    this.active.clear()
    for (const subscription of subscriptions) {
      subscription.stop()
    }
    const results = await Promise.allSettled(subscriptions.map((s) => s.drain()))
    const firstRejection = results.find((r): r is PromiseRejectedResult => r.status === "rejected")
    if (firstRejection !== undefined) {
      throw firstRejection.reason
    }
  }

  /**
   * Current number of active subscriptions. Useful for diagnostics and
   * tests.
   */
  size(): number {
    return this.active.size
  }
}
