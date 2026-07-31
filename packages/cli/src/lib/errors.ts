export interface SixbCliErrorOptions extends ErrorOptions {
  /**
   * What the operator should do next, kept out of the message so the terminal can give the
   * instruction its own place and a caller can log the diagnosis alone.
   */
  readonly remediation?: string
}

/** A failure the CLI raised itself, as opposed to one it caught from the runtime. */
export class SixbCliError extends Error {
  readonly remediation: string | undefined

  constructor(message: string, options: SixbCliErrorOptions = {}) {
    super(message, options)
    this.name = "SixbCliError"
    this.remediation = options.remediation
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Reads a remediation off an error, including through a wrapper's `cause` — wrapping is how the
 * CLI adds context to a provider's failure.
 */
export function errorRemediation(error: unknown): string | undefined {
  let current: unknown = error

  // Bounded: a cause chain is normally one or two deep, and a cycle would otherwise hang.
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof SixbCliError && current.remediation) {
      return current.remediation
    }
    current = current.cause
  }

  return undefined
}
