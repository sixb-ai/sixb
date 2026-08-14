const MAX_ANALYTICS_PAGE_SIZE = 250_000

export function analyticsPageSize(value: string | undefined, field: string): number {
  if (value === undefined) {
    return MAX_ANALYTICS_PAGE_SIZE
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`[SixbGoogle] ${field} must be a positive integer string.`)
  }

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_ANALYTICS_PAGE_SIZE) {
    throw new Error(`[SixbGoogle] ${field} must be between 1 and 250000.`)
  }
  return parsed
}

export function analyticsOffset(value: string | undefined, field: string): bigint {
  if (value === undefined) {
    return 0n
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`[SixbGoogle] ${field} must be a non-negative integer string.`)
  }
  return BigInt(value)
}

export function nextAnalyticsOffset(
  offset: bigint,
  returnedRows: number,
  totalRows: number | undefined
): bigint | undefined {
  if (returnedRows === 0) {
    return undefined
  }

  const next = offset + BigInt(returnedRows)
  if (totalRows !== undefined && next >= BigInt(totalRows)) {
    return undefined
  }
  return next
}
