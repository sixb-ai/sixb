export function longDate(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
}

export function greeting(date: Date): string {
  const hour = date.getHours()
  if (hour < 12) return "Good morning"
  if (hour < 18) return "Good afternoon"
  return "Good evening"
}

/** Up to two initials from a display name, else the first letter of an email or id. */
export function initials(name: string): string {
  const words = name.split(/[\s@._-]+/).filter(Boolean)
  const letters = words.length > 1 ? `${words[0]?.[0]}${words[1]?.[0]}` : (words[0]?.[0] ?? "?")
  return letters.toUpperCase()
}

/** A message for the person, without the `[SixbClient]`-style prefix the framework adds. */
export function errorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(/^\[Sixb\w*\]\s*/, "")
}

/** "820 KB", "3.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
