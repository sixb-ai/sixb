/**
 * Format a timestamp as a human-readable relative time string (e.g. "Just now", "5m ago").
 */
export function formatRelativeTime(timestamp: string): string {
  const diffMs = Date.now() - new Date(timestamp).getTime()
  if (Number.isNaN(diffMs)) return "Unknown"
  if (diffMs < 60_000) return "Just now"

  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * Format a duration from a past timestamp to now (e.g. "5m", "2h 15m", "3d").
 */
export function formatDuration(since: string): string {
  const diffMs = Date.now() - new Date(since).getTime()
  if (Number.isNaN(diffMs) || diffMs < 0) return "0m"

  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  const remainingMins = minutes % 60
  if (hours < 24) return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`

  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
}

/**
 * Format a timestamp as a short time string (e.g. "02:30 PM").
 */
export function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * Format a Date as a human-readable date header (e.g. "January 15, 2026").
 */
export function formatDateHeader(date: Date): string {
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  })
}

/**
 * Group timestamped items by date, sorted newest-first.
 * `getTimestamp` extracts the timestamp string from each item.
 */
export function groupByDate<T>(
  items: T[],
  getTimestamp: (item: T) => string
): { label: string; items: T[] }[] {
  const sorted = [...items].sort(
    (a, b) => new Date(getTimestamp(b)).getTime() - new Date(getTimestamp(a)).getTime()
  )

  const groups = new Map<string, T[]>()
  for (const item of sorted) {
    const key = formatDateHeader(new Date(getTimestamp(item)))
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }

  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }))
}
