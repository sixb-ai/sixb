import type { QuickBooksFaultError } from "./types"

export class QuickBooksApiError extends Error {
  readonly name = "QuickBooksApiError"

  constructor(
    readonly status: number,
    readonly requestId: string | null,
    readonly errors: readonly QuickBooksFaultError[],
    readonly faultType?: string
  ) {
    super(`[SixbQuickBooks] Accounting request failed (HTTP ${status}).`)
  }
}
