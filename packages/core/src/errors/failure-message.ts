const messages = new WeakMap<object, string>()

/**
 * Mark a framework-authored explanation for durable diagnostics. Use schema metadata and fixed
 * text only, never exception messages, input values, provider payloads, or arbitrary object keys.
 * Identity-based storage prevents an external error from opting in with a lookalike property.
 */
export function withFailureMessage<T extends Error>(error: T, message: string): T {
  messages.set(error, message)
  return error
}

export function failureMessage(error: object): string | undefined {
  return messages.get(error)
}
