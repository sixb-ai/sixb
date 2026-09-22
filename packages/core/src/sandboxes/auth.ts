import type { SandboxSource } from "./configuration"
import type { SandboxRequestCredential } from "./sandbox"

/** Per-run source access. Never persist these grants or expose them to the guest. */
export interface SandboxSourceCredentials {
  readonly requests: readonly SandboxRequestCredential[]
  readonly expiresAt: Date
  revoke(): Promise<void>
}

/** Integration-owned authentication; grant source.access (read by default), or reject. */
export interface SandboxSourceAuth {
  authorize(input: {
    readonly source: SandboxSource
    readonly signal: AbortSignal
  }): Promise<SandboxSourceCredentials>
}
