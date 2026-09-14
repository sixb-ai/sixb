import type {
  AgentWorkspaceAuth,
  AgentWorkspaceCredentials,
  ResolvedAgentWorkspace,
  Sandbox,
} from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"

const TIMEOUT_MS = 30_000
const RENEW_BEFORE_MS = 60_000

const authError = () =>
  createSixbError(
    "agent.execution_failed",
    "[SixbAgentWorker] Workspace authentication could not be confirmed."
  )

/** Owns host-side access only. Never stores credentials in workspace state or guest files. */
export class WorkspaceAuthSession {
  private readonly grants = new Set<AgentWorkspaceCredentials>()
  private readonly revocations = new Map<AgentWorkspaceCredentials, Promise<void>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private rotating: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private halted = false
  private failed = false
  private readonly inject: NonNullable<Sandbox["setRequestCredentials"]>

  constructor(
    private readonly input: {
      auth: AgentWorkspaceAuth
      source: ResolvedAgentWorkspace["source"]
      sandbox: Pick<Sandbox, "setRequestCredentials">
      signal: AbortSignal
      assertOwner(): Promise<void>
      onFailure(error: Error): void
    }
  ) {
    if (!input.sandbox.setRequestCredentials) {
      throw createSixbError(
        "agent.execution_failed",
        "[SixbAgentWorker] Workspace authentication requires a sandbox with secure credential injection."
      )
    }
    this.inject = input.sandbox.setRequestCredentials.bind(input.sandbox)
    input.signal.addEventListener("abort", this.onAbort, { once: true })
  }

  async start(): Promise<void> {
    this.input.signal.throwIfAborted()
    await this.rotate()
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
    const request = this.input.auth
      .authorize({
        source: this.input.source,
        signal: this.input.signal,
      })
      .then(async (grant) => {
        this.grants.add(grant)
        if (this.halted) await this.revoke(grant)
        return grant
      })
    let grant: AgentWorkspaceCredentials
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
      await this.input.assertOwner()
      if (this.halted) return
      await bounded(this.inject(grant.requests))
      if (this.halted) return
      for (const previous of this.grants) {
        if (previous !== grant) await this.revoke(previous)
      }
      if (this.halted) return
      this.timer = setTimeout(
        () => {
          void this.rotate().catch(() => {
            this.failed = true
            this.halted = true
            this.input.onFailure(authError())
          })
        },
        Math.min(
          2_147_483_647,
          Math.max(0, grant.expiresAt.getTime() - Date.now() - RENEW_BEFORE_MS)
        )
      )
      this.timer.unref?.()
    } catch {
      this.failed = true
      this.halted = true
      // A late token response is revoked by the request continuation above.
      throw authError()
    }
  }

  private async revoke(grant: AgentWorkspaceCredentials): Promise<void> {
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
        await this.input.assertOwner()
        await bounded(this.inject([]))
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
