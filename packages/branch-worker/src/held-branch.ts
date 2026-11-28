import { posix } from "node:path"
import {
  type Sandbox,
  type SandboxFactory,
  type SandboxNetworkTarget,
  SandboxNotRunningError,
  type SandboxProcess,
  type SandboxRequestCredential,
  type SandboxSessionOptions,
  type SixbHostView,
} from "@sixb/core"
import {
  BRANCH_CHECKOUT_MARK,
  BRANCH_DATABASE_SCHEMA_ENV,
  BRANCH_DATABASE_URL_ENV,
  BRANCH_DEPENDENCY_FILES,
  BRANCH_INSTALL_COMMAND,
  BRANCH_KEY_ENV,
  BRANCH_KEY_HEADER,
  BRANCH_PORT_ENV,
  BRANCH_PRODUCTION_ORIGIN_ENV,
  BRANCH_PUBLIC_ORIGIN_ENV,
  BRANCH_RUNTIME_COMMAND,
  BRANCH_STATUS_PATH,
  type BranchClosure,
  branchCheckout,
  branchClosureNotice,
  branchDatabaseAddress,
  branchPreviewOrigin,
  closeBranchData,
  dropBranchData,
  enforceBranchLimits,
  hostBranchDatabase,
  parseBranchRuntimeStatus,
  sourceGitUrl,
} from "@sixb/core/internal/branches"
import { reportBranchFailure } from "@sixb/core/internal/error-reporting"
import { captureSixbFailure } from "@sixb/core/internal/errors"
import { dropLakeSlice } from "@sixb/core/internal/lake-slices"
import { modelOriginsOf } from "@sixb/core/internal/model-origins"
import { BRANCH_RUNTIME_ENV } from "@sixb/core/internal/runtime"
import { waitUnlessAborted } from "@sixb/core/internal/workers"
import { SandboxStateUnavailableError, SandboxStillRunningError } from "@sixb/core/sandboxes"
import type { BranchChanges, BranchNotice, BranchRecord, BranchStorage } from "@sixb/core/storage"
import { type BranchSandboxFiles, copyIntoSandbox } from "./copy"
import { branchNetwork } from "./network"
import { freeRuntimePort } from "./ports"
import { authorizeSourceRead } from "./source-auth"

/** How often an owner looks at its branch. */
export const BRANCH_TICK_MS = 3_000
/** How long a claim on a branch lasts unless its owner renews it. */
export const BRANCH_LEASE_MS = 60_000
/** A branch nobody reaches for this long stops. */
export const BRANCH_IDLE_MS = 20 * 60_000

/** The lease is renewed this often, apart from the ticks: a copy or a checkout can outlast it. */
const HEARTBEAT_MS = BRANCH_LEASE_MS / 3
/**
 * A step that destroys what the branch has runs only while the lease holds at least this long:
 * a worker back from a pause may find another worker running the branch.
 */
const FENCE_MS = 15_000
/** The role is held to its limits this often, apart from the ticks: an import runs as the role. */
const ENFORCE_MS = 3_000
/** How far each push of the provider's deadline reaches, and so how often it is pushed. */
const KEEP_ALIVE_MS = 10 * 60_000
/** How long a started runtime may take to answer before the branch counts as failed. */
const ANSWER_DEADLINE_MS = 3 * 60_000
/** Source credentials are renewed this long before they expire. */
const CREDENTIALS_MARGIN_MS = 5 * 60_000
/** How long each step of a checkout may take, and a reinstall after a push. */
const INSTALL_TIMEOUT_MS = 10 * 60_000
/**
 * How long a branch waits for the last session of its saved sandbox to stop: that session's
 * worker died holding it, and its provider ends it once its last push of the deadline runs out.
 */
const RESUME_WAIT_MS = KEEP_ALIVE_MS + 2 * 60_000
/** How often it asks again meanwhile. */
const RESUME_RETRY_MS = 15_000
/**
 * A delete or an expiry that failed is tried again after this long, not at the next tick: the
 * worker keeps its name on the row until then, so no worker claims it before.
 */
const RETRY_MS = 2 * 60_000
/** A runtime that keeps exiting is started again after 5 s, then twice as long, up to 5 min. */
const RESTART_BACKOFF_MS = { first: 5_000, max: 5 * 60_000 } as const

export interface HeldBranchSettings {
  readonly owner: string
  readonly apiPublicOrigin: string | undefined
  readonly appPublicOrigin: string | undefined
  /** The project's `dev` values, read with the deployment's dev credential; null without one. */
  readonly devEnv: (() => Promise<Readonly<Record<string, string>> | null>) | undefined
  /** What a branch's sandbox reaches beyond its defaults. */
  readonly allow: readonly SandboxNetworkTarget[]
}

/** What a branch nobody runs says of itself. */
export const STOPPED: BranchChanges = {
  state: "stopped",
  url: null,
  generation: null,
  owner: null,
  leaseExpiresAt: null,
}

const NO_DEV_ENV: BranchNotice = {
  code: "no-dev-env",
  message:
    "It runs without the project's dev values: the branch worker has no credential to read them.",
}
const DATA_RESET: BranchNotice = {
  code: "data-reset",
  message:
    "Its data was reset: the branch's machine was lost, so it runs on a new copy of production.",
}
const TEMP_FILES_UNCAPPED: BranchNotice = {
  code: "temp-files-uncapped",
  message:
    "Production may not cap its temporary files (temp_file_limit): one heavy query can fill production's disk. Grant production's database user SET on temp_file_limit.",
}
const MACHINE_ENDED: BranchNotice = {
  code: "machine-ended",
  message: "Its machine reached its provider's time limit, so it stopped. Open it to go on.",
}

class LostBranchError extends Error {}

/**
 * One worker's hold on one branch: its copy, its sandbox, its runtime and the lease on its row.
 * Two timers run beside the work, whatever it is doing: one renews the lease, and lets the
 * branch go when it cannot renew it in time, as another worker may hold it then; the other holds
 * the branch's role to its limits, an import or a checkout included.
 */
export class HeldBranch {
  private readonly branches: BranchStorage
  /** Ends what the hold does: the worker is stopping or draining, or the hold lost the branch. */
  private readonly controller = new AbortController()
  /**
   * The row as this hold last read or wrote it: what it decides on. The heartbeat keeps
   * `branch` fresh for its revision, and never moves this, so a delete it brings is still news
   * to `write`.
   */
  private decidedOn: BranchRecord
  /** Whether the hold ended because another worker may hold the branch now. */
  private lost = false
  /** Why production closed the branch: its runtime can log in no more, so it stops. */
  private closure: BranchClosure | null = null
  private sandbox: Sandbox | undefined
  private runtime: { readonly process: SandboxProcess; exited: boolean } | undefined
  private url: string | undefined
  private credentials:
    | {
        readonly requests: readonly SandboxRequestCredential[]
        readonly expiresAt: Date
        revoke(): Promise<void>
      }
    | undefined
  private devValues: Readonly<Record<string, string>> = {}
  private notices: readonly BranchNotice[] = []
  /** The commit the sandbox's checkout is at, as far as this hold knows. */
  private checkedOut: string | null = null
  /** Until when the lease is known to be this hold's. */
  private leaseUntil: number
  private startedAt = 0
  private answered = false
  private requestsSeen = 0
  private restarts = 0
  private restartAt = 0
  private keptAliveAt = 0
  /** When this hold delivered a copy the runtime has not reported loaded yet. */
  private delivered: Date | null = null
  /** That copy's lake slice, which production keeps until the branch lets it go. */
  private deliveredSlice: string | null = null
  /** When this hold's last copy began: a runtime still reporting an older one is not done. */
  private copyStartedAt: Date | null = null
  private renewing: Promise<void> | undefined
  private enforcing: Promise<void> | undefined

  constructor(
    private readonly host: SixbHostView,
    private readonly settings: HeldBranchSettings,
    private branch: BranchRecord,
    /** Aborts when the worker stops or drains: the hold puts the branch back for the next one. */
    private readonly stopping: AbortSignal
  ) {
    this.branches = host.storage.hostedBranches as BranchStorage
    this.decidedOn = branch
    this.leaseUntil = branch.leaseExpiresAt?.getTime() ?? 0
    if (stopping.aborted) this.controller.abort()
    stopping.addEventListener("abort", () => this.controller.abort(), { once: true })
  }

  private get signal(): AbortSignal {
    return this.controller.signal
  }

  /** Works toward what the branch's row wants until it lets the branch go. */
  async life(): Promise<void> {
    const heartbeat = setInterval(() => void this.renewLease(), HEARTBEAT_MS)
    const enforcement = setInterval(() => void this.enforceLimits(), ENFORCE_MS)
    try {
      if (this.branch.wanted === "deleted") return await this.teardown()

      await this.open()
      while (!this.signal.aborted) {
        if (await this.tick()) return
        await waitUnlessAborted(BRANCH_TICK_MS, this.signal)
      }

      // The worker is stopping, or lost the branch: its sandbox keeps its state for the next.
      await this.read()
      await this.close({})
    } catch (error) {
      await this.failed(error)
    } finally {
      clearInterval(heartbeat)
      clearInterval(enforcement)
      await this.renewing
      await this.enforcing
    }
  }

  /** Deletes the copy of a branch unopened for too long. Its next open takes a new one. */
  async expire(): Promise<void> {
    try {
      await this.releaseSlices()
      await this.fence()
      await dropBranchData(this.host, this.branch)
      if (this.branch.sandbox) await destroySaved(this.host, this.branch.sandbox)
      await this.write({ ...STOPPED, data: null, sandbox: null, port: null })
    } catch (error) {
      console.error(`[SixbBranchWorker] Branch '${this.branch.name}' kept its expired copy.`, error)
      await this.write({ leaseExpiresAt: new Date(Date.now() + RETRY_MS) }).catch(() => {})
    }
  }

  /** Lets the branch go after `error`, saying what became of it. */
  private async failed(error: unknown): Promise<void> {
    if (error instanceof LostBranchError || this.lost) {
      await this.release({ lost: true })
      return
    }

    // The worker stopped it mid-step: it goes back as any stop puts it, for the next worker.
    if (this.stopping.aborted) {
      await this.close({}).catch(async (closing: unknown) => {
        console.error(
          `[SixbBranchWorker] Could not put branch '${this.branch.name}' back.`,
          closing
        )
        await this.release()
      })
      return
    }

    await this.release()

    // A delete that failed stays wanted: a claim tries it again once the lease, held a while
    // longer, lapses.
    if (this.branch.wanted === "deleted") {
      console.error(`[SixbBranchWorker] Branch '${this.branch.name}' is not deleted yet.`, error)
      await this.write({
        leaseExpiresAt: new Date(Date.now() + RETRY_MS),
        error: { message: errorMessage(error) },
      }).catch(() => {})
      return
    }

    // Its provider ended the machine, at its time limit: the branch stops, and says why.
    if (error instanceof SandboxNotRunningError) {
      await this.write({
        ...STOPPED,
        wanted: "stopped",
        notices: [...this.notices.filter((notice) => notice !== MACHINE_ENDED), MACHINE_ENDED],
      }).catch(() => {})
      return
    }

    // It stays failed until someone opens it again: the project hears of it as of any failure.
    reportBranchFailure(this.host, error, {
      projectId: this.host.id,
      branch: this.branch.name,
      failure: captureSixbFailure(error, {
        allowedCodes: ["internal.unexpected"],
        defaultCode: "internal.unexpected",
      }),
    })
    await this.write({
      ...STOPPED,
      wanted: "stopped",
      state: "failed",
      error: { message: errorMessage(error) },
    }).catch(() => {})
  }

  /**
   * Pushes the lease out, whatever the hold is doing. A row another worker holds now ends the
   * hold; so does a lease it could not renew before it ran out, as another worker may take the
   * branch then: the hold stops acting on it.
   */
  private renewLease(): Promise<void> {
    this.renewing ??= (async () => {
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const row = await this.branches.get({ projectId: this.host.id, name: this.branch.name })
          if (!row || row.owner !== this.settings.owner) {
            this.lose()
            return
          }

          const until = Date.now() + BRANCH_LEASE_MS
          const renewed = await this.branches.update(
            { projectId: this.host.id, name: row.name, revision: row.revision, at: new Date() },
            { leaseExpiresAt: new Date(until) }
          )
          if (renewed) {
            this.leaseUntil = until
            if (renewed.revision > this.branch.revision) this.branch = renewed
            return
          }
        }
      } catch (error) {
        console.error(
          `[SixbBranchWorker] Could not renew the lease on '${this.branch.name}'.`,
          error
        )
      } finally {
        this.renewing = undefined
      }

      if (Date.now() + HEARTBEAT_MS >= this.leaseUntil) {
        console.error(
          `[SixbBranchWorker] The lease on '${this.branch.name}' runs out unrenewed: letting the branch go.`
        )
        this.lose()
      }
    })()
    return this.renewing
  }

  /**
   * Goes on only while this hold owns the branch, for long enough: right before each step that
   * destroys what the branch has, its database, its role or its sandbox. A worker paused past its
   * lease (a machine asleep) wakes to I/O that runs before its heartbeat: renewing first tells
   * it whether another worker took the branch meanwhile.
   */
  private async fence(): Promise<void> {
    this.signal.throwIfAborted()
    if (Date.now() + FENCE_MS < this.leaseUntil) return

    await this.renewLease()
    this.signal.throwIfAborted()
    if (Date.now() + FENCE_MS >= this.leaseUntil) throw new LostBranchError()
  }

  /** Ends the hold: another worker may hold the branch now, so it touches nothing more. */
  private lose(): void {
    this.lost = true
    this.controller.abort()
  }

  /** Holds the branch's role to its limits: it may SET its own timeouts away. */
  private enforceLimits(): Promise<void> {
    this.enforcing ??= enforceBranchLimits(this.host, this.branch)
      .then((enforced) => {
        this.closure ??= enforced.closed
      })
      .catch((error: unknown) => {
        console.error(
          `[SixbBranchWorker] Could not hold branch '${this.branch.name}' to its limits.`,
          error
        )
      })
      .finally(() => {
        this.enforcing = undefined
      })
    return this.enforcing
  }

  /** Returns whether this owner is done with the branch. */
  private async tick(): Promise<boolean> {
    const branch = await this.read()
    const now = Date.now()

    if (branch.wanted === "deleted") {
      await this.stopRuntime()
      await this.teardown()
      return true
    }
    if (branch.wanted === "stopped") {
      await this.close({})
      return true
    }
    // Production closed it for what it took: it stops, and says why.
    if (this.closure) {
      const notice = branchClosureNotice(this.closure)
      await this.close({
        wanted: "stopped",
        notices: [...this.notices.filter((known) => known.code !== notice.code), notice],
      })
      return true
    }
    if (now - branch.lastSeenAt.getTime() > BRANCH_IDLE_MS) {
      await this.close({ wanted: "stopped" })
      return true
    }
    if (this.sandbox && this.sandbox.status !== "running") {
      throw new SandboxNotRunningError(`[SixbBranchWorker] The sandbox of '${branch.name}' ended.`)
    }

    if (now - this.keptAliveAt > KEEP_ALIVE_MS / 2) {
      this.keptAliveAt = now
      await this.sandbox?.keepAlive?.(KEEP_ALIVE_MS).catch((error: unknown) => {
        console.error(`[SixbBranchWorker] Could not keep branch '${branch.name}' alive.`, error)
      })
    }
    await this.renewCredentials(now)

    if (this.needsCopy()) {
      // A new copy replaces the old one whole: what the branch wrote goes with it.
      await this.stopRuntime()
      if (await this.copy()) await this.startRuntime()
    }

    if (branch.remoteCommit && branch.remoteCommit !== this.checkedOut) await this.pull(branch)
    await this.restartExited(now)
    await this.report(now)
    return false
  }

  private async open(): Promise<void> {
    const { host } = this
    const sandboxes = host.sandboxes
    if (!sandboxes) throw new Error("[SixbBranchWorker] The project has no sandbox factory.")
    const source = requireSource(host)

    await this.authorizeSource()
    await this.write({ state: "starting", error: null })

    // Production's own environment never reaches the sandbox, and its network reaches only what
    // the branch needs.
    const session = {
      network: await branchNetwork({
        gitUrl: sourceGitUrl(source),
        apiPublicOrigin: this.settings.apiPublicOrigin,
        database: branchDatabaseAddress(host),
        models: modelOriginsOf(host.definitions.models),
        duckLake: host.lakeStorage.standard?.id === "ducklake",
        allow: this.settings.allow,
      }),
      ...(this.credentials?.requests.length
        ? { requestCredentials: this.credentials.requests }
        : {}),
    }

    this.sandbox = (await this.resumeSaved(sandboxes, session)) ?? undefined
    // The worker is stopping, or the branch is no longer wanted running: `close` saves what was
    // resumed, and the tick does the rest.
    if (this.signal.aborted || this.branch.wanted !== "running") return

    const resumed = this.sandbox !== undefined
    this.sandbox ??= await this.createSandbox(sandboxes, session)

    const { start, url } = this.sandbox
    if (!start || !url) {
      throw new Error(
        `[SixbBranchWorker] The sandbox provider '${this.sandbox.provider}' cannot run a branch: it needs start and url.`
      )
    }
    this.url = url(this.branch.port as number)
    this.checkedOut = await this.headCommit()

    const devValues = await this.settings.devEnv?.()
    this.devValues = devValues ?? {}
    // What its last copy found of production's instance stays true until the next one.
    this.notices = [
      ...(devValues ? [] : [NO_DEV_ENV]),
      ...this.branch.notices.filter((notice) => notice.code === TEMP_FILES_UNCAPPED.code),
    ]

    // A sandbox made anew lost what the branch wrote outside its database, its lake catalog among
    // it: a whole new copy, rather than half of one.
    const lost = !resumed && this.branch.data !== null
    if (lost) this.notices = [...this.notices, DATA_RESET]
    const waiting = (lost || this.needsCopy()) && !(await this.copy())
    if (!waiting) await this.startRuntime()
    await this.write({ url: this.url, notices: this.notices })
  }

  /**
   * The branch's saved sandbox, resumed with this session; null when there is none to resume, as
   * its provider has no saved state or its state is gone. One whose last session still runs, its
   * worker gone without stopping it, is waited for until its provider stops it: a sandbox made
   * meanwhile could not take its name. Anything else fails the branch, and the name stays.
   */
  private async resumeSaved(
    sandboxes: SandboxFactory,
    session: SandboxSessionOptions
  ): Promise<Sandbox | null> {
    const name = this.branch.sandbox
    if (!sandboxes.resume || !name || this.branch.port === null) return null

    const deadline = Date.now() + RESUME_WAIT_MS
    let stoppedStale = false
    for (;;) {
      try {
        const sandbox = await sandboxes.resume(name, session)
        if (await this.finishedCheckout(sandbox)) return sandbox

        // Its first checkout failed, or its worker died during it: it is made anew.
        console.error(
          `[SixbBranchWorker] Branch '${this.branch.name}''s saved sandbox never finished its checkout; making it anew.`
        )
        await sandbox.stop()
        return null
      } catch (error) {
        if (error instanceof SandboxStateUnavailableError) {
          console.error(
            `[SixbBranchWorker] Branch '${this.branch.name}' has no saved sandbox left; making it anew.`
          )
          return null
        }
        if (!(error instanceof SandboxStillRunningError)) throw error
        if (Date.now() >= deadline) {
          throw new Error(
            `[SixbBranchWorker] The last session of branch '${this.branch.name}''s sandbox still runs after ${RESUME_WAIT_MS / 60_000} minutes. Stop it from the provider's dashboard, then open the branch again.`,
            { cause: error }
          )
        }
      }

      // Its worker died holding it, and the provider keeps it up while its deadline lasts: this
      // hold owns the branch now, so it stops that session, saving its state, then resumes it.
      if (!stoppedStale && sandboxes.stop) {
        await this.fence()
        await sandboxes.stop(name)
        stoppedStale = true
        continue
      }

      console.error(
        `[SixbBranchWorker] The last session of branch '${this.branch.name}''s sandbox still runs; waiting for it to stop.`
      )
      await waitUnlessAborted(RESUME_RETRY_MS, this.signal)
      if (this.signal.aborted) return null

      // Stopped or deleted meanwhile: the tick does what was asked.
      if ((await this.read()).wanted !== "running") return null
    }
  }

  /**
   * A new sandbox for the branch. A provider that saves sandboxes keeps one under the branch's
   * name, which it makes only once: whatever an earlier sandbox left there goes first. It serves
   * the ports a sandbox was made with, so the name keeps its port.
   */
  private async createSandbox(
    sandboxes: SandboxFactory,
    session: SandboxSessionOptions
  ): Promise<Sandbox> {
    const { host } = this
    const name = sandboxes.resume ? `sixb-branch-${host.id}-${this.branch.namespace}` : null
    const port = name && this.branch.port !== null ? this.branch.port : await freeRuntimePort()

    if (name) await destroySaved(host, name)

    // Written first, so a crash during creation still names what it left behind.
    await this.write({ sandbox: name, port })
    const sandbox = await sandboxes.create({
      ...session,
      signal: this.signal,
      environment: {},
      ports: [port],
      ...(name ? { persistence: { name } } : {}),
    })

    try {
      await this.checkOut(sandbox)
    } catch (error) {
      // A saved sandbox keeps its name, unmarked: its next open makes it anew.
      await (name ? sandbox.stop() : sandbox.destroy()).catch(() => {})
      throw error
    }
    return sandbox
  }

  /**
   * Clones the branch into a new sandbox and installs what it needs, each step a command of the
   * worker's own: bounded as a reinstall is, and failing with its own words.
   */
  private async checkOut(sandbox: Sandbox): Promise<void> {
    const steps = branchCheckout({ source: requireSource(this.host), branch: this.branch.name })

    for (const step of steps) {
      const result = await sandbox.runCommand("sh", ["-c", step.script], {
        timeout: INSTALL_TIMEOUT_MS,
        signal: this.signal,
      })
      if (result.timedOut) {
        throw new Error(
          `[SixbBranchWorker] Could not ${step.name}: it took longer than ${INSTALL_TIMEOUT_MS / 60_000} minutes.`
        )
      }
      if (result.exitCode !== 0) {
        throw new Error(
          `[SixbBranchWorker] Could not ${step.name}: ${lastLines(result.stderr) || `exit ${result.exitCode}`}`
        )
      }
    }
  }

  /** Whether a resumed sandbox's checkout finished: its last step leaves a mark. */
  private async finishedCheckout(sandbox: Sandbox): Promise<boolean> {
    const mark = await sandbox.runCommand("test", ["-f", BRANCH_CHECKOUT_MARK], {
      timeout: 30_000,
      signal: this.signal,
    })
    return mark.exitCode === 0
  }

  /**
   * Takes a new copy of production for the branch, which its runtime loads when it starts:
   * `copy.ts` says how. False while there is no place for it: the next tick asks again.
   */
  private async copy(): Promise<boolean> {
    // A copy drops the database first: only the branch's owner may. Until it ends, the branch has
    // no copy, rather than half of one. The last copy's slice is read no more.
    await this.read()
    await this.releaseSlices()
    await this.write({ state: "copying", error: null, data: null })

    this.copyStartedAt = new Date()
    const delivered = await copyIntoSandbox(this.host, this.branch, this.files(), {
      apiUrl: requireApiOrigin(this.settings),
    })
    if (!delivered) return false

    this.deliveredSlice = delivered.lakeSliceId
    this.delivered = new Date()
    this.notices = [
      ...this.notices.filter((notice) => notice.code !== TEMP_FILES_UNCAPPED.code),
      ...(delivered.tempFileLimit ? [] : [TEMP_FILES_UNCAPPED]),
    ]
    // A copy that took long counts as use: the branch stops idle only from here.
    await this.write({ state: "starting", lastSeenAt: new Date(), notices: this.notices })
    return true
  }

  /**
   * Whether the branch needs a new copy: it has none loaded nor delivered, or a refresh was asked
   * for after the one it has.
   */
  private needsCopy(): boolean {
    const { branch } = this
    const copied = branch.data?.takenAt ?? this.delivered
    if (!copied) return true
    if (!branch.refreshRequestedAt) return false
    return branch.refreshRequestedAt.getTime() > copied.getTime()
  }

  /** Starts the runtime with its role's new password, the branch's key and its lake's files. */
  private async startRuntime(): Promise<void> {
    const { sandbox } = this
    // A closed branch logs in no more: a new start would give its role a new login.
    if (!sandbox?.start || this.closure) return

    const process = await sandbox.start("sh", ["-c", BRANCH_RUNTIME_COMMAND], {
      cwd: this.projectDirectory(),
      env: await this.runtimeEnv(),
    })

    const runtime = { process, exited: false }
    this.runtime = runtime
    this.startedAt = Date.now()
    this.answered = false
    this.requestsSeen = 0
    void process.exited.then(() => {
      runtime.exited = true
    })
  }

  /**
   * What the runtime starts with: the project's `dev` values, then branch mode's variables and the
   * role's new login over them. Its copy, and the credential it reads production with, are files.
   */
  private async runtimeEnv(): Promise<Record<string, string>> {
    const { branch } = this
    const database = await hostBranchDatabase(this.host, branch)
    const origin = this.publicOrigin()
    const publicOrigin: Readonly<Record<string, string>> = origin
      ? { [BRANCH_PUBLIC_ORIGIN_ENV]: origin }
      : {}
    // Production's app, which the branch's bar links back to.
    const production: Readonly<Record<string, string>> = this.settings.appPublicOrigin
      ? { [BRANCH_PRODUCTION_ORIGIN_ENV]: this.settings.appPublicOrigin.replace(/\/+$/, "") }
      : {}

    return {
      ...this.devValues,
      SIXB_BRANCH: branch.name,
      SIXB_BRANCH_DATA_FROM: "production",
      // Its jobs are its own: a laptop running the same git branch shares none of them.
      [BRANCH_RUNTIME_ENV]: `hosted-${branch.namespace}`,
      [BRANCH_KEY_ENV]: branch.key,
      [BRANCH_PORT_ENV]: String(branch.port),
      ...publicOrigin,
      ...production,
      [BRANCH_DATABASE_URL_ENV]: database.url,
      [BRANCH_DATABASE_SCHEMA_ENV]: database.schemaName,
    }
  }

  private async stopRuntime(): Promise<void> {
    await this.runtime?.process.kill().catch(() => {})
    this.runtime = undefined
  }

  /** Starts a runtime that exited again: 5 s after it exits, then twice as long each time. */
  private async restartExited(now: number): Promise<void> {
    if (!this.runtime?.exited) return

    if (this.restartAt === 0) {
      this.restartAt =
        now + Math.min(RESTART_BACKOFF_MS.first * 2 ** this.restarts, RESTART_BACKOFF_MS.max)
      this.restarts += 1
    }
    if (now < this.restartAt) return

    this.restartAt = 0
    await this.startRuntime()
  }

  /**
   * Makes the checkout the branch's head on the remote. A checkout already there rewrites
   * nothing, so the runtime's watcher restarts only on a change. A push that changes the
   * dependencies stops the runtime, installs them, then starts it: no generation starts on the
   * old ones.
   */
  private async pull(branch: BranchRecord): Promise<void> {
    const sandbox = this.requireSandbox()
    const inCheckout = (script: string, timeout = 120_000) =>
      sandbox.runCommand("sh", ["-c", script], {
        cwd: this.checkoutDirectory(),
        env: { SIXB_BRANCH: branch.name },
        timeout,
        signal: this.signal,
      })

    const fetched = await inCheckout(
      'git fetch --quiet origin "$SIXB_BRANCH" && git diff --name-only HEAD FETCH_HEAD'
    )
    if (fetched.exitCode !== 0) {
      console.error(
        `[SixbBranchWorker] Could not update branch '${branch.name}': ${fetched.stderr.trim()}`
      )
      return
    }

    const dependencies = fetched.stdout
      .split("\n")
      .some((path) => BRANCH_DEPENDENCY_FILES.includes(posix.basename(path.trim())))
    if (dependencies) await this.stopRuntime()

    await inCheckout("git reset --quiet --hard FETCH_HEAD")
    if (dependencies) {
      const installed = await inCheckout(BRANCH_INSTALL_COMMAND, INSTALL_TIMEOUT_MS)
      if (installed.exitCode !== 0) {
        console.error(
          `[SixbBranchWorker] Could not install branch '${branch.name}''s dependencies: ${installed.stderr.trim()}`
        )
      }
      await this.startRuntime()
    }
    this.checkedOut = (await this.headCommit()) ?? branch.remoteCommit
  }

  private async headCommit(): Promise<string | null> {
    const head = await this.requireSandbox()
      .runCommand("git", ["rev-parse", "HEAD"], {
        cwd: this.checkoutDirectory(),
        timeout: 30_000,
      })
      .catch(() => null)
    return head?.exitCode === 0 ? head.stdout.trim() || null : null
  }

  /** Writes what the runtime's front reports, and when someone last used it. */
  private async report(now: number): Promise<void> {
    const { url, branch } = this
    if (!url) return

    // The branch's code answers here: a redirect would have production's worker carry the key
    // anywhere on its network.
    const status = await fetch(new URL(BRANCH_STATUS_PATH, url), {
      headers: { [BRANCH_KEY_HEADER]: branch.key },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    })
      .then(async (response) => parseBranchRuntimeStatus(await response.json()))
      .catch(() => null)

    if (!status) {
      if (!this.answered && now - this.startedAt > ANSWER_DEADLINE_MS) {
        throw new Error(`The branch's runtime never answered.${await this.logTail()}`)
      }
      return
    }

    this.answered = true
    if (status.state === "ready") this.restarts = 0

    // The copy the runtime loaded becomes the branch's: until then, it has the one delivered.
    const fresh =
      status.copy !== null &&
      status.copy.takenAt !== branch.data?.takenAt.toISOString() &&
      (this.copyStartedAt === null ||
        Date.parse(status.copy.takenAt) >= this.copyStartedAt.getTime())
    const loaded =
      fresh && status.copy
        ? {
            data: {
              takenAt: new Date(status.copy.takenAt),
              objects: status.copy.objects,
              skipped: status.copy.skipped,
              partial: status.copy.partial,
              refusedByDeploy: status.copy.refusedByDeploy,
              unchecked: status.copy.unchecked,
              migrated: status.copy.migrated,
              skippedDatasets: status.copy.skippedDatasets,
              lakeSliceId: status.copy.lakeSliceId,
            },
          }
        : {}
    if (loaded.data) {
      this.delivered = null
      this.deliveredSlice = null
    }
    const changes: BranchChanges = {
      state: status.state,
      generation: status.generation,
      commit: status.commit,
      error: status.error,
      ...loaded,
    }
    const changed = (Object.keys(changes) as (keyof typeof changes)[]).some(
      (key) => JSON.stringify(changes[key]) !== JSON.stringify(branch[key])
    )
    const used = status.requests > this.requestsSeen
    this.requestsSeen = status.requests

    if (changed || used) {
      await this.write({ ...changes, ...(used ? { lastSeenAt: new Date(now) } : {}) })
    }
  }

  /** The end of the runtime's log, which says why it does not answer. */
  private async logTail(): Promise<string> {
    const tail = await this.sandbox
      ?.runCommand("tail", ["-n", "20", ".sixb/branch.log"], {
        cwd: this.projectDirectory(),
        timeout: 10_000,
      })
      .catch(() => null)
    const lines = tail?.exitCode === 0 ? tail.stdout.trim() : ""
    return lines ? ` Its log ends with:\n${lines}` : ""
  }

  /** Read access to the repository, as the branch's creator, from the project's source auth. */
  private async authorizeSource(): Promise<void> {
    this.credentials =
      (await authorizeSourceRead(this.host, {
        signal: this.signal,
        requestedBy: { type: "user", id: this.branch.createdBy },
      })) ?? undefined
  }

  private async renewCredentials(now: number): Promise<void> {
    const current = this.credentials
    if (!current || current.expiresAt.getTime() - now > CREDENTIALS_MARGIN_MS) return

    await this.authorizeSource()
    await this.sandbox?.setRequestCredentials?.(this.credentials?.requests ?? [])
    await current.revoke().catch(() => {})
  }

  /** Stops the runtime and saves the sandbox, then lets the branch go. */
  private async close(changes: BranchChanges): Promise<void> {
    await this.stopRuntime()
    await this.releaseUnloaded()
    await this.credentials?.revoke().catch(() => {})
    const sandbox = this.sandbox
    this.sandbox = undefined
    if (sandbox) {
      await sandbox.stop()
      if (!this.host.sandboxes?.resume) await sandbox.destroy()
    }
    // A password the branch's code kept opens nothing until its next start.
    await closeBranchData(this.host, this.branch)
    await this.write({ ...STOPPED, ...changes })
  }

  /**
   * Drops everything the branch has: its sandbox, its database and role, then its row. A step that
   * fails keeps the row, wanted deleted, so the next claim tries again: a sandbox still running
   * branch code is never left without one.
   */
  private async teardown(): Promise<void> {
    await this.credentials?.revoke().catch(() => {})
    await this.fence()
    await this.sandbox?.destroy()
    this.sandbox = undefined
    if (this.branch.sandbox) await destroySaved(this.host, this.branch.sandbox)
    await this.releaseSlices()
    await this.fence()
    await dropBranchData(this.host, this.branch)
    await this.branches.delete({ projectId: this.host.id, name: this.branch.name })
  }

  /**
   * Lets production drop the lake slices this branch's copies read: the one the row has, and one
   * delivered and not loaded yet. Production keeps a slice, and the files it holds, until then.
   */
  private async releaseSlices(): Promise<void> {
    const slices = new Set([this.branch.data?.lakeSliceId, this.deliveredSlice])
    for (const id of slices) {
      if (id) await dropLakeSlice(this.host, id)
    }
    this.deliveredSlice = null
  }

  /**
   * Lets production drop the slice of a copy this hold delivered and the runtime never loaded:
   * the row does not name it, so no later hold could. The next open takes a new copy anyway.
   */
  private async releaseUnloaded(): Promise<void> {
    const slice = this.deliveredSlice
    if (!slice || this.branch.data?.lakeSliceId === slice) return

    this.deliveredSlice = null
    this.delivered = null
    await dropLakeSlice(this.host, slice).catch((error: unknown) => {
      console.error(
        `[SixbBranchWorker] Could not release the lake slice of branch '${this.branch.name}''s unloaded copy.`,
        error
      )
    })
  }

  /**
   * Drops this worker's hold without touching the sandbox's saved state. A hold that lost the
   * branch to another worker stops its own session still: a saved sandbox's handle is pinned to
   * the session this hold resumed or made, so stopping it never reaches the session another
   * worker resumes, and a session left running would keep the name from resuming.
   */
  private async release(options: { readonly lost?: boolean } = {}): Promise<void> {
    await this.stopRuntime()
    await this.releaseUnloaded()
    await this.credentials?.revoke().catch(() => {})
    // A hold that lost the branch leaves its login to the worker that took it.
    if (!options.lost) {
      await closeBranchData(this.host, this.branch).catch((error: unknown) => {
        console.error(
          `[SixbBranchWorker] Could not take branch '${this.branch.name}''s login away; the next stop tries again.`,
          error
        )
      })
    }
    await this.sandbox?.stop().catch(() => {})
    if (!this.host.sandboxes?.resume) await this.sandbox?.destroy().catch(() => {})
  }

  /**
   * The branch as stored, while this worker still holds it. A worker back from a pause past its
   * lease finds another worker's name on the row, or a revision moved on under its writes.
   */
  private async read(): Promise<BranchRecord> {
    const branch = await this.branches.get({ projectId: this.host.id, name: this.branch.name })
    if (!branch || branch.owner !== this.settings.owner) throw new LostBranchError()

    this.branch = branch
    this.decidedOn = branch
    return branch
  }

  /**
   * Writes over what this worker last read, reading again when someone else moved it on. What it
   * wants for the branch it decided on the row it read: once someone asked for something since,
   * it writes what it found and leaves `wanted` to them.
   */
  private async write(changes: BranchChanges): Promise<void> {
    const decidedOn = this.decidedOn

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const written = await this.branches.update(
        {
          projectId: this.host.id,
          name: this.branch.name,
          revision: this.branch.revision,
          at: new Date(),
        },
        askedSince(decidedOn, this.branch) ? withoutWanted(changes) : changes
      )
      if (written) {
        this.branch = written
        this.decidedOn = written
        return
      }
      await this.read()
    }
    throw new Error(
      `[SixbBranchWorker] Branch '${this.branch.name}' kept changing under its owner.`
    )
  }

  /** Where people open the branch: under the preview domain, or at its sandbox's URL. */
  private publicOrigin(): string | null {
    return this.url
      ? branchPreviewOrigin(
          { namespace: this.branch.namespace, url: this.url },
          this.host.source?.previewDomain ?? null
        )
      : null
  }

  private requireSandbox(): Sandbox {
    if (!this.sandbox) throw new Error("[SixbBranchWorker] The branch has no sandbox yet.")
    return this.sandbox
  }

  private files(): BranchSandboxFiles {
    return {
      sandbox: this.requireSandbox(),
      projectDirectory: this.projectDirectory(),
      signal: this.signal,
      fence: () => this.fence(),
    }
  }

  /** The checkout: the sandbox's working directory. */
  private checkoutDirectory(): string {
    return this.sandbox?.workingDirectory ?? "."
  }

  /** Where the project is in the checkout: `source.path`, or its root. */
  private projectDirectory(): string {
    return posix.join(this.checkoutDirectory(), requireSource(this.host).path ?? ".")
  }
}

/**
 * Deletes the sandbox a provider saved under `name`, by name: no session, no credentials. One
 * already gone is done; a failure throws, so the branch keeps the name and tries again.
 */
async function destroySaved(host: SixbHostView, name: string): Promise<void> {
  const destroy = host.sandboxes?.destroy
  if (!destroy) {
    throw new Error(
      `[SixbBranchWorker] The sandbox provider cannot delete the saved sandbox '${name}': it needs destroy(name).`
    )
  }
  await destroy.call(host.sandboxes, name)
}

function requireSource(host: SixbHostView) {
  if (!host.source) throw new Error("[SixbBranchWorker] The project names no repository.")
  return host.source
}

function requireApiOrigin(settings: HeldBranchSettings): string {
  if (!settings.apiPublicOrigin) {
    throw new Error(
      "[SixbBranchWorker] A branch reads production's lake and files from production's API: set SIXB_API_PUBLIC_ORIGIN."
    )
  }
  return settings.apiPublicOrigin.replace(/\/+$/, "")
}

/** Whether someone asked something of the branch since `before`: a delete, a stop, an open. */
function askedSince(before: BranchRecord, now: BranchRecord): boolean {
  return (
    now.wanted !== before.wanted ||
    now.openedAt.getTime() !== before.openedAt.getTime() ||
    now.refreshRequestedAt?.getTime() !== before.refreshRequestedAt?.getTime()
  )
}

function withoutWanted(changes: BranchChanges): BranchChanges {
  const { wanted: _wanted, ...rest } = changes
  return rest
}

/** The end of a command's output: where git and installers say what went wrong. */
function lastLines(output: string, count = 20): string {
  return output.trim().split("\n").slice(-count).join("\n")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
