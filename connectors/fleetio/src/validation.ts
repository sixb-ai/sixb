import type { FleetioId } from "./types"

/** Fleetio's maximum for `per_page`. */
const MAX_PAGE_SIZE = 100

export function assertPageSize(pageSize: number | undefined): void {
  if (pageSize === undefined) {
    return
  }

  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`[SixbFleetio] pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}.`)
  }
}

export function pathId(value: FleetioId, field: string): string {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`[SixbFleetio] ${field} must be a positive integer.`)
    }

    return String(value)
  }

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[SixbFleetio] ${field} must not be empty.`)
  }

  return encodeURIComponent(value)
}
