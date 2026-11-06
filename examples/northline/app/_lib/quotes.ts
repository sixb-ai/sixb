/** A quote's document view. */
export function quotePath(primaryId: string): string {
  return `/quotes?quote=${encodeURIComponent(primaryId)}`
}
