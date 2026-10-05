export class PlaudApiError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string
  ) {
    super(`[SixbPlaud] ${operation} failed (HTTP ${status}).`)
    this.name = "PlaudApiError"
  }
}
