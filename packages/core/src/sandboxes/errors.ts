import { SixbError, type SixbErrorCode, type SixbErrorOptions } from "../errors"

export interface SandboxErrorOptions extends SixbErrorOptions {
  /** Subclasses narrow the failure; direct callers of `SandboxError` leave this alone. */
  readonly code?: Extract<SixbErrorCode, `sandbox.${string}`>
}

/**
 * Errors thrown by sandbox providers. Hosts can catch SandboxError at the
 * audit boundary while still distinguishing recoverable provider states.
 */
export class SandboxError extends SixbError {
  override readonly name: string = "SandboxError"

  constructor(message: string, options: SandboxErrorOptions = {}) {
    super(options.code ?? "sandbox.failed", message, options)
  }
}

/** runCommand / stop / destroy called after the sandbox is stopped or destroyed. */
export class SandboxNotRunningError extends SandboxError {
  override readonly name = "SandboxNotRunningError"

  constructor(message: string, options: SixbErrorOptions = {}) {
    super(message, { ...options, code: "sandbox.not_running" })
  }
}

/** Command exceeded its timeout and was killed. */
export class SandboxTimeoutError extends SandboxError {
  override readonly name = "SandboxTimeoutError"

  constructor(message: string, options: SixbErrorOptions = {}) {
    super(message, { ...options, code: "sandbox.timed_out" })
  }
}

/** Requested isolation backend is not available on the host. */
export class SandboxIsolationUnavailableError extends SandboxError {
  override readonly name = "SandboxIsolationUnavailableError"

  constructor(message: string, options: SixbErrorOptions = {}) {
    super(message, { ...options, code: "sandbox.isolation_unavailable" })
  }
}
