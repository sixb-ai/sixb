export class PlaudApiError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string
  ) {
    super(`[SixbPlaud] ${operation} failed (HTTP ${status}).`)
    this.name = "PlaudApiError"
  }
}

export class PlaudAuthError extends Error {
  constructor(
    readonly reason: "login_required" | "refresh_uncertain" | "storage" | "rejected",
    message: string
  ) {
    super(`[SixbPlaud] ${message}`)
    this.name = "PlaudAuthError"
  }
}
