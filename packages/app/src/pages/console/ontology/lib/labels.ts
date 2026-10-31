const acronymTokens = new Set(["api", "cpu", "gpu", "id", "ip", "mac", "os", "sla", "tv", "ui"])

export function humanizeIdentifier(value: string): string {
  if (!value) return value

  const normalized = value
    .replace(/[./_]+/g, " ")
    .replace(/-/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .trim()
    .replace(/\s+/g, " ")

  if (!normalized) return value

  return normalized
    .split(" ")
    .map((token) => {
      const lower = token.toLowerCase()
      if (acronymTokens.has(lower)) return lower.toUpperCase()
      if (/^[0-9]+$/.test(token)) return token
      if (/^[A-Z0-9]{4,}$/.test(token) && !/[a-z]/.test(token)) return token
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(" ")
}

export function formatLocation(location?: Record<string, string> | string): string {
  if (!location) return "No location set"
  if (typeof location === "string") return location

  const priority = ["site", "building", "floor", "zone", "room", "area", "system"]
  const parts: string[] = []
  const seen = new Set<string>()

  for (const key of priority) {
    const value = location[key]
    if (!value) continue
    parts.push(value)
    seen.add(key)
  }

  for (const [key, value] of Object.entries(location)) {
    if (!value || seen.has(key)) continue
    parts.push(value)
  }

  return parts.length > 0 ? parts.join(" / ") : "No location set"
}
