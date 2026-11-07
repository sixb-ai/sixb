/** A quote's document view. */
export function quotePath(primaryId: string): string {
  return `/quotes?quote=${encodeURIComponent(primaryId)}`
}

/** A quote still waiting on a decision, from Northline or from the customer. */
export function isQuoteOpen(status: string | undefined): boolean {
  return status === "internal_review" || status === "sent"
}
