/**
 * A registered subscription with handles the registry can use to stop and
 * finalize it. Redis-specific client lifecycle lives in the caller.
 */
export interface ActiveSubscription {
  /** Stop delivery quickly. Must be safe to call more than once. */
  stop(): void
  /** Await cleanup. May throw; callers decide how to surface the error. */
  drain(): Promise<void>
}

/** Tracks active subscriptions so `RedisBroker.close()` can drain them. */
export class SubscriptionRegistry {
  private readonly active = new Set<ActiveSubscription>()

  register(subscription: ActiveSubscription): () => void {
    this.active.add(subscription)
    return () => {
      if (!this.active.delete(subscription)) {
        return
      }
      subscription.stop()
      subscription.drain().catch((error: unknown) => {
        console.error("[RedisBroker] Failed to drain subscription during unsubscribe:", error)
      })
    }
  }

  async drain(): Promise<void> {
    const subscriptions = [...this.active]
    this.active.clear()
    for (const subscription of subscriptions) {
      subscription.stop()
    }
    const results = await Promise.allSettled(
      subscriptions.map((subscription) => subscription.drain())
    )
    const firstRejection = results.find((r): r is PromiseRejectedResult => r.status === "rejected")
    if (firstRejection !== undefined) {
      throw firstRejection.reason
    }
  }

  size(): number {
    return this.active.size
  }
}
