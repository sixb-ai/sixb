export interface ExpirationOptions {
  readonly expiresAt?: string
  readonly expiresIn?: string
}

export function resolveExpiration(options: ExpirationOptions): string {
  if (options.expiresAt?.trim()) {
    const date = new Date(options.expiresAt)
    if (Number.isNaN(date.getTime())) {
      throw new Error("[SixbCLI] --expires-at must be a valid date or ISO timestamp.")
    }
    return date.toISOString()
  }

  const duration = parseDurationMs(options.expiresIn ?? "90d")
  return new Date(Date.now() + duration).toISOString()
}

export function normalizeGroupIds(values: readonly string[] | undefined): string[] {
  const groupIds: string[] = []
  for (const value of values ?? []) {
    for (const groupId of value.split(",")) {
      const trimmed = groupId.trim()
      if (trimmed && !groupIds.includes(trimmed)) {
        groupIds.push(trimmed)
      }
    }
  }

  return groupIds
}

export function formatGroups(groupIds: readonly string[] | undefined): string {
  if (!groupIds) return "Inherited"
  if (groupIds.length === 0) return "None"
  return groupIds.join(",")
}

export function formatDate(value: string | undefined): string {
  if (!value) return "Never"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toISOString().replace("T", " ").slice(0, 16)
}

function parseDurationMs(value: string): number {
  const match = value.trim().match(/^(\d+)(m|h|d|w|y)$/)
  if (!match) {
    throw new Error("[SixbCLI] Use --expires-in like 30d, 12h, 4w, or 1y.")
  }

  const amount = Number(match[1])
  const unit = match[2]
  const multipliers = {
    m: 60_000,
    h: 60 * 60_000,
    d: 24 * 60 * 60_000,
    w: 7 * 24 * 60 * 60_000,
    y: 365 * 24 * 60 * 60_000,
  } as const

  return amount * multipliers[unit as keyof typeof multipliers]
}
