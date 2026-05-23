export class OidcAuthError extends Error {
  readonly name = "OidcAuthError"

  constructor(message: string) {
    super(`[Pario] ${message}`)
  }
}
