import { createHash } from "node:crypto"
import type { SourceListInput, SourcePage } from "./contracts"

interface Receipt {
  operation: string
  fingerprint: string
  resultId: string
}

export function pageRows<T>(rows: readonly T[], input: SourceListInput = {}): SourcePage<T> {
  const offset = parseCursor(input.cursor)
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500)
  const page = rows.slice(offset, offset + limit).map((row) => structuredClone(row))
  const nextOffset = offset + page.length
  return {
    rows: page,
    ...(nextOffset < rows.length ? { nextCursor: String(nextOffset) } : {}),
  }
}

export function orderedChangesSince<T extends object>(
  changes: readonly T[],
  cursor?: string
): Array<T & { readonly cursor: string }> {
  const offset = parseCursor(cursor)
  if (offset > changes.length) {
    throw new Error(
      `[NorthlineSource] Source cursor '${cursor}' is beyond the retained change history.`
    )
  }

  return changes.slice(offset).map((change, index) => ({
    ...structuredClone(change),
    cursor: String(offset + index + 1),
  }))
}

export function runIdempotently<T>(
  receipts: Record<string, Receipt>,
  key: string,
  operation: string,
  input: unknown,
  find: (id: string) => T | undefined,
  create: () => T,
  id: (value: T) => string
): T {
  if (!key.trim()) throw new Error("[NorthlineSource] An idempotency key is required.")
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex")
  const receipt = receipts[key]
  if (receipt) {
    if (receipt.operation !== operation || receipt.fingerprint !== fingerprint) {
      throw new Error(
        `[NorthlineSource] Idempotency key '${key}' was already used for different input.`
      )
    }
    const existing = find(receipt.resultId)
    if (!existing) {
      throw new Error(`[NorthlineSource] Idempotency result '${receipt.resultId}' is missing.`)
    }
    return structuredClone(existing)
  }

  const result = create()
  receipts[key] = { operation, fingerprint, resultId: id(result) }
  return structuredClone(result)
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  const value = Number(cursor)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`[NorthlineSource] Invalid source cursor '${cursor}'.`)
  }
  return value
}
