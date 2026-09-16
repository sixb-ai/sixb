import type { QuickBooksFaultError } from "./types"

export class QuickBooksApiError extends Error {
  readonly name = "QuickBooksApiError"

  constructor(
    readonly status: number,
    readonly requestId: string | null,
    readonly errors: readonly QuickBooksFaultError[],
    readonly faultType?: string,
    readonly writeRequestId?: string
  ) {
    super(`[SixbQuickBooks] Accounting request failed (HTTP ${status}).`)
  }
}

/** A write did not yield a usable response. Its outcome may be unknown; reconcile before retrying. */
export class QuickBooksWriteError extends Error {
  readonly name = "QuickBooksWriteError"

  constructor(
    readonly writeRequestId: string,
    cause: unknown
  ) {
    super("[SixbQuickBooks] Write did not return a usable response; reconcile before retrying.", {
      cause,
    })
  }
}
