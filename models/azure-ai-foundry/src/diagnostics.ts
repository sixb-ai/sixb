import { ModelProviderError } from "@sixb/core/models"

/** Credentials belong to one request, including its retries, never to the provider instance. */
export class RequestDiagnostics {
  private readonly secrets = new Set<string>()

  add(value: string): void {
    if (value.trim()) this.secrets.add(value.trim())
  }

  text(value: string): string {
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length))
      value = value.replaceAll(secret, "[REDACTED]")
    return value
  }

  providerError(error: ModelProviderError): ModelProviderError {
    return new ModelProviderError(this.text(error.message), error.providerId, error.modelId, {
      status: error.status,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
      code: error.code === undefined ? undefined : this.text(error.code),
      requestId: error.requestId === undefined ? undefined : this.text(error.requestId),
      reason: error.reason,
    })
  }

  failure(error: unknown): Error {
    if (error instanceof ModelProviderError) return this.providerError(error)
    // Rebuild rather than attaching an unsanitized cause, stack or custom properties.
    const sanitized = new Error(this.text(error instanceof Error ? error.message : String(error)))
    sanitized.name = error instanceof Error ? this.text(error.name) : "Error"

    // A failed connection's code, such as ECONNRESET, on fetch's error (Bun) or its cause (Node):
    // it tells the model loop the call may be made again.
    const code = errorCode(error) ?? errorCode(error instanceof Error ? error.cause : undefined)
    if (code !== undefined) Object.assign(sanitized, { code: this.text(code) })
    return sanitized
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code: unknown = Reflect.get(error, "code")
  return typeof code === "string" ? code : undefined
}
