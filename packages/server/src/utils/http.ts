export function toIsoString(value: Date): string {
  return value.toISOString()
}

export function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${value}`)
  }

  return parsed
}

export function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer: ${value}`)
  }

  return parsed
}

export function handleRouteError(
  error: unknown,
  set: { status?: number | string }
): {
  error: string
} {
  const message = error instanceof Error ? error.message : String(error)
  set.status = message.includes("not found") || message.includes("Unknown") ? 404 : 400
  return { error: message }
}
