function formatObjectValue(value: Record<string, unknown>, depth: number): string {
  const entries = Object.entries(value)
  if (entries.length === 0) return "{}"

  const parts = entries.map(([key, childValue]) => `${key}: ${formatValue(childValue, depth + 1)}`)

  if (depth === 0) return parts.join(", ")
  return `{ ${parts.join(", ")} }`
}

export function formatValue(value: unknown, depth = 0): string {
  if (value === null) return "null"

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    const items = value.map((item) => formatValue(item, depth + 1))
    return `[${items.join(", ")}]`
  }

  if (typeof value === "object") {
    if (depth >= 3) return "{...}"
    return formatObjectValue(value as Record<string, unknown>, depth)
  }

  return String(value)
}

export function formatCount(value: number): string {
  return value.toLocaleString()
}
