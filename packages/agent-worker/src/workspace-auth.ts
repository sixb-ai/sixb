import type {
  Sandbox,
  SandboxSource,
  SandboxSourceAuth,
  SandboxSourceCredentials,
} from "@sixb/core"
import { captureSandboxEnv } from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"

const TIMEOUT_MS = 30_000
const RENEW_BEFORE_MS = 60_000

// The integration's error is the cause, and onError receives it. The stored run failure keeps
// the catalog message plus any upstream HTTP status or network code found in the cause chain,
// never the integration's own message.
const authError = (cause?: unknown) =>
  createSixbError(
    "agent.execution_failed",
    "[SixbAgentWorker] Workspace authentication could not be confirmed.",
    { cause }
  )

/** The first grant as the caller sees it. Requests stay host-side; only `env` reaches the guest. */
export interface WorkspaceGrant {
  readonly requests: SandboxSourceCredentials["requests"]
  readonly env: Readonly<Record<string, string>>
}

/** Owns host-side access only. Never stores credentials in workspace state or guest files. */
export class WorkspaceAuthSession {
  private readonly grants = new Set<SandboxSourceCredentials>()
  private readonly revocations = new Map<SandboxSourceCredentials, Promise<void>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private rotating: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private halted = false
  private failed = false
  private inject?: NonNullable<Sandbox["setRequestCredentials"]>
  private current?: SandboxSourceCredentials
  private env?: Readonly<Record<string, string>>

  constructor(
    private readonly input: {
      auth: SandboxSourceAuth
      source: SandboxSource
      signal: AbortSignal
      assertOwner(): Promise<void>
      onFailure(error: Error): void
    }
  ) {
    input.signal.addEventListener("abort", this.onAbort, { once: true })
  }

  /** Called only after the provider has applied prepare()'s credentials before initialization. */
  attach(sandbox: Pick<Sandbox, "setRequestCredentials">): void {
    this.input.signal.throwIfAborted()
    if (this.halted || !this.current) throw authError()
    if (!sandbox.setRequestCredentials) {
      throw createSixbError(
        "agent.execution_failed",
        "[SixbAgentWorker] Workspace authentication requires a sandbox with secure credential injection."
      )
    }
    this.inject = sandbox.setRequestCredentials.bind(sandbox)
  }

  /** The first grant: its request origins join the session network. */
  async prepare(): Promise<WorkspaceGrant> {
    this.input.signal.throwIfAborted()
    await this.rotate()
    if (this.halted || !this.current || !this.env) throw authError()
    return { requests: this.current.requests, env: this.env }
  }

  private readonly onAbort = () => {
    this.halted = true
    clearTimeout(this.timer)
    // Revoking this run's grants is safe even after execution ownership is lost.
    // Do not touch the sandbox here: cancellation may be a lost queue lease.
    void this.revokeAll().catch(() => {
      this.failed = true
      console.error("[SixbAgentWorker] Workspace token revocation failed after interruption.")
    })
  }

  private rotate(): Promise<void> {
    const operation = this.refresh()
    this.rotating = operation
    return operation
  }

  private async refresh(): Promise<void> {
    await this.input.assertOwner()
    if (this.halted) return
    const request = Promise.resolve()
      .then(() =>
        this.input.auth.authorize({
          source: this.input.source,
          signal: this.input.signal,
        })
      )
      .then(async (grant) => {
        this.grants.add(grant)
        if (this.halted) await this.revoke(grant)
        return grant
      })
    let grant: SandboxSourceCredentials
    try {
      grant = await bounded(request)
      if (this.halted) return
      if (
        !(grant.expiresAt instanceof Date) ||
        !Number.isFinite(grant.expiresAt.getTime()) ||
        grant.expiresAt.getTime() <= Date.now() + RENEW_BEFORE_MS ||
        !Array.isArray(grant.requests) ||
        !grant.requests.length ||
        typeof grant.revoke !== "function"
      )
        throw authError()

      // Every request origin joins the run's network, so it must name exactly one host.
      if (!grant.requests.every((request) => isSingleHostOrigin(request.origin))) {
        throw new Error(
          "[SixbAgentWorker] Source auth must issue credentials for exact https:// origins, never wildcard hosts."
        )
      }

      // The guest environment is fixed when the session is acquired; renewals only rotate
      // requests, so a later grant's env is ignored rather than failing a running session.
      const env = this.env ?? (grant.env === undefined ? {} : captureSandboxEnv(grant.env))

      await this.input.assertOwner()
      if (this.halted) return
      if (this.inject) await bounded(this.inject(grant.requests))
      if (this.halted) return
      for (const previous of this.grants) {
        if (previous !== grant) await this.revoke(previous)
      }
      if (this.halted) return
      this.current = grant
      this.env = env
      this.timer = setTimeout(
        () => {
          if (!this.inject) {
            // Provisioning/setup has not returned a session handle yet. Abort before expiry;
            // never renew an access policy on an unowned or unknown provider session.
            this.failed = true
            this.halted = true
            this.input.onFailure(authError())
            return
          }
          void this.rotate().catch((error: unknown) => {
            this.failed = true
            this.halted = true
            this.input.onFailure(authError(error))
          })
        },
        Math.min(
          2_147_483_647,
          Math.max(0, grant.expiresAt.getTime() - Date.now() - RENEW_BEFORE_MS)
        )
      )
      this.timer.unref?.()
    } catch (error) {
      this.failed = true
      this.halted = true
      // A late token response is revoked by the request continuation above.
      throw authError(error)
    }
  }

  private async revoke(grant: SandboxSourceCredentials): Promise<void> {
    const existing = this.revocations.get(grant)
    if (existing) return existing
    const operation = bounded(grant.revoke())
      .then(() => {
        this.grants.delete(grant)
      })
      .finally(() => {
        this.revocations.delete(grant)
      })
    this.revocations.set(grant, operation)
    await operation
  }

  private async revokeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.grants].map((grant) => this.revoke(grant)))
    if (results.some((result) => result.status === "rejected")) throw authError()
  }

  /** Drain rotation, remove injection, and revoke every known token before finalization. */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.halted = true
    clearTimeout(this.timer)
    this.input.signal.removeEventListener("abort", this.onAbort)
    this.closing = (async () => {
      let error = this.failed
      try {
        if (this.rotating) await bounded(this.rotating)
      } catch {
        error = true
      }
      try {
        if (this.inject) {
          await this.input.assertOwner()
          await bounded(this.inject([]))
        }
      } catch {
        error = true
      }
      try {
        await this.revokeAll()
      } catch {
        error = true
      }
      if (error) throw authError()
    })()
    return this.closing
  }
}

/** An origin as written, whose host is not a wildcard a provider would read as many domains. */
function isSingleHostOrigin(origin: unknown): boolean {
  if (typeof origin !== "string") return false

  try {
    const url = new URL(origin)
    return url.protocol === "https:" && url.origin === origin && !url.hostname.includes("*")
  } catch {
    return false
  }
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(authError()), TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
