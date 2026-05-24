/**
 * Errors thrown by sandbox providers. Hosts can catch SandboxError at the
 * audit boundary while still distinguishing recoverable provider states.
 */
export class SandboxError extends Error {
  readonly name: string = "SandboxError"
}

/** runCommand / stop / destroy called after the sandbox is stopped or destroyed. */
export class SandboxNotRunningError extends SandboxError {
  override readonly name = "SandboxNotRunningError"
}

/** Command exceeded its timeout and was killed. */
export class SandboxTimeoutError extends SandboxError {
  override readonly name = "SandboxTimeoutError"
}

/** Requested isolation backend is not available on the host. */
export class SandboxIsolationUnavailableError extends SandboxError {
  override readonly name = "SandboxIsolationUnavailableError"
}
