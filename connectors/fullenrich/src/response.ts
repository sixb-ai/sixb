import { FullEnrichApiError } from "./errors"
import { isRecord } from "./validation"

// Responses are typed from FullEnrich's documented schema. These guards check the envelope the
// client relies on; record fields stay as returned.

export function jobStarted(operation: string, body: Record<string, unknown>) {
  if (typeof body.enrichment_id !== "string" || !body.enrichment_id) {
    throw malformed(operation, "enrichment_id must be a non-empty string")
  }
  return { enrichment_id: body.enrichment_id }
}

export function job<T>(operation: string, body: unknown): T {
  if (!isRecord(body)) throw malformed(operation, "the body must be an object")
  if (typeof body.id !== "string" || !body.id) {
    throw malformed(operation, "id must be a non-empty string")
  }
  if (typeof body.status !== "string") throw malformed(operation, "status must be a string")
  if (body.data !== undefined && body.data !== null && !Array.isArray(body.data)) {
    throw malformed(operation, "data must be an array")
  }
  return body as T
}

/** A result list that FullEnrich may omit when nothing matched. */
export function list<T>(operation: string, body: Record<string, unknown>, field: string): T[] {
  const value = body[field]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw malformed(operation, `${field} must be an array of objects`)
  }
  return value as T[]
}

export function metadata<T>(operation: string, body: Record<string, unknown>): T | undefined {
  if (body.metadata === undefined || body.metadata === null) return undefined
  if (!isRecord(body.metadata)) throw malformed(operation, "metadata must be an object")
  return body.metadata as T
}

export function malformed(operation: string, detail: string): FullEnrichApiError {
  return new FullEnrichApiError(
    `[SixbFullEnrich] FullEnrich ${operation} returned a malformed response: ${detail}.`
  )
}
