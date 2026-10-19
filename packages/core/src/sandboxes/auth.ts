import type { SandboxSource } from "./configuration"
import type { SandboxRequestCredential } from "./sandbox"

/** Per-run source access. Never persist these grants or expose them to the guest. */
export interface SandboxSourceCredentials {
  /**
   * Sixb opens these origins in the run's network, whether the recipe omits `network` or
   * restricts it, so each must be one exact `https://` origin: a wildcard host is rejected. The
   * network is set from the first grant of a session: return requests for the same origins on
   * renewal.
   */
  readonly requests: readonly SandboxRequestCredential[]
  /**
   * Guest-readable variables the integration needs in the sandbox, such as identities or the
   * placeholder a tool requires before the host replaces its Authorization header. Never a
   * credential: commands, files and snapshots can read these values.
   *
   * Applied from the first grant of a session; the recipe's own `env` wins on collision. Return
   * the same values on renewal: renewals only rotate `requests`, so later values are ignored.
   */
  readonly env?: Readonly<Record<string, string>>
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
