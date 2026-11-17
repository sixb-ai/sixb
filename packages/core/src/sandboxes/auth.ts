import type { ConnectorAccessToken, ConnectorConnectionSelector } from "../connectors/types"
import type { AuthorizablePrincipal } from "../execution/types"
import type { SandboxSource } from "./configuration"
import type { SandboxRequestCredential } from "./sandbox"

/** Registered OAuth connector accepted by host-side sandbox source authentication. */
export interface SandboxOAuthConnector {
  readonly kind: "connector"
  readonly id: string
  readonly adapter: {
    readonly authentication: {
      readonly type: "oauth2"
    }
  }
}

/** Resolve a live token from an OAuth connector connection on the host. */
export type SandboxConnectionTokenResolver = (
  connector: SandboxOAuthConnector,
  selector: ConnectorConnectionSelector
) => Promise<ConnectorAccessToken>

export interface SandboxSourceAuthInput {
  readonly source: SandboxSource
  readonly signal: AbortSignal
  /** Who requested the run, when a person or service account started it. */
  readonly requestedBy?: AuthorizablePrincipal
  /**
   * Resolve a live access token from an OAuth connector connection on the host.
   * Enforces the same requester and member-status rules as `sixb.connector()`.
   */
  readonly connectionToken?: SandboxConnectionTokenResolver
}

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
  /** A thrown error is reported to onError: it and its causes must never contain a credential. */
  authorize(input: SandboxSourceAuthInput): Promise<SandboxSourceCredentials>
}
