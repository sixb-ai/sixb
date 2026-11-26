import { randomUUID } from "node:crypto"
import type { SandboxNetworkTarget, SixbHostView } from "@sixb/core"
import {
  branchesUnavailable,
  branchHostingRequirement,
  closeBranchData,
} from "@sixb/core/internal/branches"
import { Worker, waitUnlessAborted } from "@sixb/core/internal/workers"
import type { BranchRecord, BranchStorage } from "@sixb/core/storage"
import {
  BRANCH_LEASE_MS,
  BRANCH_TICK_MS,
  HeldBranch,
  type HeldBranchSettings,
  STOPPED,
} from "./held-branch"
import { BranchMirror } from "./mirror"
import { clearStaleStaging } from "./staging"

export { BRANCH_IDLE_MS, BRANCH_LEASE_MS, BRANCH_TICK_MS } from "./held-branch"

/** A branch nobody opens for this long loses its copy: the next open takes a new one. */
export const BRANCH_UNOPENED_MS = 14 * 24 * 60 * 60_000
/** How often the worker reads the remote's heads, unless a branch waits for its first read. */
export const BRANCH_MIRROR_MS = 10_000

/** Branches one worker holds at once. */
const DEFAULT_CONCURRENCY = 4

export interface BranchWorkerOptions {
  /** Branches this worker runs at once. Defaults to 4. */
  readonly concurrency?: number
  /** Production's API origin, which a branch reads production's lake files from. */
  readonly apiPublicOrigin?: string
  /** Production's app origin, which a branch's banner links back to. Without it, it links nowhere. */
  readonly appPublicOrigin?: string
  /**
   * The project's `dev` values for each branch it starts, read with a credential for `dev` only:
   * never production's. Null, or absent, starts branches without them, which their notice says.
   */
  readonly devEnv?: () => Promise<Readonly<Record<string, string>> | null>
  /**
   * More than a branch's sandbox reaches by default (production's PostgreSQL and API, the git
   * host, the package registries): the services its `dev` values point at, for one.
   */
  readonly allow?: readonly SandboxNetworkTarget[]
}

/**
 * Runs the project's git branches next to production, where they're wanted: claims a branch
 * nobody holds once its remote has it, copies what its creator reads, opens its sandbox, starts
 * its runtime, pulls what is pushed to it, and stops it once nobody uses it. One read of the
 * remote tells every branch what it holds. It also deletes the copy of a branch unopened for 14
 * days, and everything of a deleted one. Several workers can run: the lease on a branch's row
 * lets one hold it. `packages/core/src/branches/README.md` has the lifecycle.
 */
export class BranchWorker extends Worker {
  readonly concurrency: number
  private readonly owner = `branch-worker-${randomUUID()}`
  private readonly held = new Map<string, Promise<void>>()
  /** The revision each stopped branch was at when this worker last took its login away. */
  private readonly closedAt = new Map<string, number>()
  private readonly branches: BranchStorage
  private readonly settings: HeldBranchSettings
  private readonly mirror: BranchMirror
  private mirroredAt = Number.NEGATIVE_INFINITY
  private mirroring: Promise<void> | undefined

  /**
   * Why this host cannot run branches, or null when it can: asked before a worker is made, so
   * `sixb worker` refuses before it changes anything.
   */
  static unmetRequirement(
    host: SixbHostView,
    environment: string | undefined = process.env.NODE_ENV
  ): string | null {
    const unavailable = branchesUnavailable(host, environment)
    return unavailable ? `needs ${unavailable.message}` : null
  }

  constructor(
    private readonly host: SixbHostView,
    options: BranchWorkerOptions = {}
  ) {
    super()

    const unmet = BranchWorker.unmetRequirement(host)
    if (unmet) throw new Error(`[SixbBranchWorker] The branch worker ${unmet}.`)

    this.branches = host.storage.hostedBranches as BranchStorage
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
    this.mirror = new BranchMirror(host, this.branches)
    this.settings = {
      owner: this.owner,
      apiPublicOrigin: options.apiPublicOrigin,
      appPublicOrigin: options.appPublicOrigin,
      devEnv: options.devEnv,
      allow: options.allow ?? [],
    }
  }

  /**
   * Starts once production's PostgreSQL can host branches: a database user without `CREATEROLE`
   * or `CREATEDB` is refused before the worker claims anything.
   */
  override async start(): Promise<void> {
    const unmet = await branchHostingRequirement(this.host)
    if (unmet) throw new Error(`[SixbBranchWorker] The branch worker ${unmet}.`)

    await super.start()
  }

  /** Waits for the branches this worker holds to be put back, at most `timeoutMs`. */
  drain(timeoutMs?: number): Promise<boolean> {
    return this.drainRunning(timeoutMs)
  }

  protected async run(signal: AbortSignal): Promise<void> {
    await clearStaleStaging()

    let waiting = false
    while (!signal.aborted && !this.drainSignal.aborted) {
      // Beside the claims, never in their way: a slow remote holds up no running branch. A
      // branch just opened is read at the next tick.
      const due = Date.now() - this.mirroredAt >= (waiting ? BRANCH_TICK_MS : BRANCH_MIRROR_MS)
      if (!this.mirroring && due) this.readRemote(signal)

      try {
        waiting = await this.claim(signal)
      } catch (error) {
        console.error(
          "[SixbBranchWorker] Could not look after the project's branches; retrying.",
          error
        )
      }
      await waitUnlessAborted(BRANCH_TICK_MS, this.drainSignal)
    }

    await Promise.allSettled([...this.held.values(), this.mirroring])
    await this.mirror.close()
  }

  private readRemote(signal: AbortSignal): void {
    this.mirroredAt = Date.now()
    this.mirroring = this.mirror
      .check(signal)
      .catch((error: unknown) => {
        // A stopping worker kills its git: nothing went wrong.
        if (signal.aborted || this.drainSignal.aborted) return
        console.error(
          "[SixbBranchWorker] Could not read the project's repository; retrying.",
          error
        )
      })
      .finally(() => {
        this.mirroring = undefined
      })
  }

  /** Claims what it can; returns whether a wanted branch still waits for the remote's word. */
  private async claim(signal: AbortSignal): Promise<boolean> {
    const now = new Date()
    let waiting = false

    for (const branch of await this.branches.list({ projectId: this.host.id })) {
      // A worker that began stopping claims nothing more: what it let go is the next worker's.
      if (signal.aborted || this.drainSignal.aborted) return waiting
      if (this.held.has(branch.name) || this.held.size >= this.concurrency) continue

      const lapsed =
        branch.owner === null || (branch.leaseExpiresAt?.getTime() ?? 0) < now.getTime()
      if (!lapsed) continue

      if (branch.wanted === "stopped") {
        await this.settleStopped(branch, now)
        continue
      }
      // Not before the remote has the branch: its read says whether it does.
      if (branch.wanted === "running" && branch.remoteCommit === null) {
        waiting = true
        continue
      }

      const claimed = await this.branches.update(
        { projectId: this.host.id, name: branch.name, revision: branch.revision, at: now },
        { owner: this.owner, leaseExpiresAt: new Date(now.getTime() + BRANCH_LEASE_MS) }
      )
      if (!claimed) continue

      // A drain puts the branch back at once, as a stop does: the next worker opens it.
      const stopping = AbortSignal.any([signal, this.drainSignal])
      this.hold(branch.name, new HeldBranch(this.host, this.settings, claimed, stopping).life())
    }
    return waiting
  }

  /**
   * A stopped branch nobody holds. Once it went 14 days unopened its copy goes, database and role
   * included: taking the copy again is the next open's. Otherwise its login goes, whoever left it:
   * a worker that died holding it left its runtime's sessions running, with nothing holding them
   * to their limits. The worker claims the row first, through its revision, so it never closes a
   * login another worker just opened, and once per revision, as nothing logs in to a row that
   * stays put. The row then says it stopped; a failed one keeps saying why.
   */
  private async settleStopped(branch: BranchRecord, now: Date): Promise<void> {
    const ref = { projectId: this.host.id, name: branch.name, revision: branch.revision, at: now }
    const unopened = now.getTime() - branch.openedAt.getTime() > BRANCH_UNOPENED_MS

    if (unopened && branch.data !== null) {
      const claimed = await this.branches.update(ref, {
        owner: this.owner,
        leaseExpiresAt: new Date(now.getTime() + BRANCH_LEASE_MS),
      })
      if (!claimed) return

      const held = new HeldBranch(this.host, this.settings, claimed, new AbortController().signal)
      this.hold(branch.name, held.expire())
      return
    }

    if (this.closedAt.get(branch.name) === branch.revision) return

    const claimed = await this.branches.update(ref, {
      owner: this.owner,
      leaseExpiresAt: new Date(now.getTime() + BRANCH_LEASE_MS),
    })
    if (!claimed) return

    try {
      await closeBranchData(this.host, claimed)
    } catch (error) {
      // The claim lapses with its lease, and a later pass tries again.
      console.error(
        `[SixbBranchWorker] Could not take branch '${branch.name}''s login away.`,
        error
      )
      return
    }

    const settled = await this.branches.update(
      { ...ref, revision: claimed.revision },
      { ...STOPPED, ...(claimed.state === "failed" ? { state: "failed" } : {}) }
    )
    if (settled) this.closedAt.set(branch.name, settled.revision)
  }

  private hold(name: string, work: Promise<void>): void {
    this.held.set(name, work)
    void work.finally(() => this.held.delete(name))
  }
}
