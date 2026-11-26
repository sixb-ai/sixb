/**
 * Errors thrown by sandbox providers. Hosts can catch SandboxError at the
 * audit boundary while still distinguishing recoverable provider states.
 */
export class SandboxError extends Error {
  readonly name: string = "SandboxError"
}

/** Confirmed missing/expired state. Never use for transport, authorization or session setup errors. */
export class SandboxStateUnavailableError extends SandboxError {
  override readonly name = "SandboxStateUnavailableError"
}

/**
 * Resume found the named sandbox's last session still running: nothing was resumed or changed.
 * It resumes once that session stops, as its provider stops one nobody keeps alive.
 */
export class SandboxStillRunningError extends SandboxError {
  override readonly name = "SandboxStillRunningError"
}

/**
 * The provider refused the request before anything ran: an HTTP 4xx answer, or a request its own
 * validation rejected. Unlike a transport failure, it proves the sandbox did nothing, so a caller
 * may go on as if the call was never made. Its message names why, and is safe to show to the
 * model and the user: it holds nothing a guest command could not already see.
 */
export class SandboxRequestRefusedError extends SandboxError {
  override readonly name = "SandboxRequestRefusedError"
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

/**
 * The longest delay a JavaScript timer holds, in milliseconds: a longer one fires at once. A
 * provider that times its commands with a timer caps their timeouts here.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * A command's timeout within its provider's maximum. Absent or zero stays as it is: the provider's
 * default, or no timeout.
 */
export function cappedCommandTimeout(
  timeout: number | undefined,
  maxCommandTimeout: number
): number | undefined {
  return timeout === undefined || timeout <= 0 ? timeout : Math.min(timeout, maxCommandTimeout)
}
