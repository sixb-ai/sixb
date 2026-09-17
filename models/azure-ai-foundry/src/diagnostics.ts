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
    })
  }

  failure(error: unknown): Error {
    if (error instanceof ModelProviderError) return this.providerError(error)
    // Rebuild rather than attaching an unsanitized cause, stack or custom properties.
    const sanitized = new Error(this.text(error instanceof Error ? error.message : String(error)))
    sanitized.name = error instanceof Error ? this.text(error.name) : "Error"
    return sanitized
  }
}
