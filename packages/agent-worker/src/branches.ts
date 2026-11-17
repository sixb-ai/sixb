import { randomUUID } from "node:crypto"
import type {
  ProjectSource,
  Sandbox,
  SandboxDefinition,
  SandboxFactory,
  SandboxProcess,
} from "@sixb/core"
import { createAgentThreadSandboxName, projectSourceEnvironment } from "@sixb/core/internal/agents"
import {
  BRANCH_KEY_ENV,
  BRANCH_KEY_HEADER,
  BRANCH_RUNTIME_COMMAND,
  BRANCH_STATUS_PATH,
  parseBranchRuntimeStatus,
} from "@sixb/core/internal/branches"
import { sandboxProjectDirectory } from "@sixb/core/sandboxes"
import type { BranchChanges, BranchRecord, BranchStorage } from "@sixb/core/storage"
import { waitForAbort } from "./run-fate"
import { WorkspaceAccess } from "./workspace-access"

/** How often an owner looks at its branch, and the worker at branches nobody holds. */
const TICK_MS = 3_000
/** How long a claim on a branch lasts unless its owner renews it. */
const LEASE_MS = 60_000
/** A branch nobody reaches for this long stops. Its sandbox keeps its state for the next open. */
export const BRANCH_IDLE_MS = 20 * 60_000
/** How far each push of the provider's deadline reaches, and so how often it is pushed. */
const KEEP_ALIVE_MS = 10 * 60_000
/** How long a started runtime may take to answer before the branch counts as failed. */
const ANSWER_DEADLINE_MS = 3 * 60_000

export interface BranchRuntimesHost {
  readonly id: string
  readonly source: ProjectSource
  readonly sandboxes: SandboxFactory
  readonly sandboxDefinition?: SandboxDefinition
  readonly branches: BranchStorage
}

/**
 * Keeps the project's branches running where they're wanted: claims a branch nobody holds, opens
 * its sandbox, starts its runtime, pulls what is pushed to it, and stops it once nobody reaches it.
 * Each worker process runs one; the lease on a branch's row lets only one of them hold it.
 */
export class BranchRuntimes {
  private readonly owner = `branch-owner-${randomUUID()}`
  private readonly held = new Map<string, Promise<void>>()

  constructor(private readonly host: BranchRuntimesHost) {}

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.claim(signal)
      } catch (error) {
        console.error(
          "[SixbAgentWorker] Could not look after the project's branches; retrying.",
          error
        )
      }
      await waitForAbort(TICK_MS, signal)
    }
    await Promise.allSettled(this.held.values())
  }

  private async claim(signal: AbortSignal): Promise<void> {
    const now = new Date()
    for (const branch of await this.host.branches.list({ projectId: this.host.id })) {
      if (this.held.has(branch.name)) continue
      const lapsed =
        branch.owner === null || (branch.leaseExpiresAt?.getTime() ?? 0) < now.getTime()
      if (!lapsed) continue

      if (branch.wanted === "stopped") {
        // Its owner stopped renewing without stopping it: nobody can reach that runtime now.
        if (branch.state !== "stopped") {
          await this.host.branches.update(
            { projectId: this.host.id, name: branch.name, revision: branch.revision, at: now },
            STOPPED
          )
        }
        continue
      }

      const claimed = await this.host.branches.update(
        { projectId: this.host.id, name: branch.name, revision: branch.revision, at: now },
        { owner: this.owner, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) }
      )
      if (!claimed) continue
      const held = new HeldBranch(this.host, this.owner, claimed, signal).life()
      this.held.set(branch.name, held)
      void held.finally(() => this.held.delete(branch.name))
    }
  }
}

const STOPPED: BranchChanges = {
  state: "stopped",
  url: null,
  generation: null,
  manifest: null,
  owner: null,
  leaseExpiresAt: null,
}

class LostBranchError extends Error {}

/** One worker's hold on one branch: its sandbox, its runtime and the lease on its row. */
class HeldBranch {
  private sandbox: Sandbox | undefined
  private access: WorkspaceAccess | undefined
  private runtime: { readonly process: SandboxProcess; exited: boolean } | undefined
  private url: string | undefined
  private startedAt = 0
  private keptAliveAt = 0
  private readonly abort = new AbortController()

  constructor(
    private readonly host: BranchRuntimesHost,
    private readonly owner: string,
    private branch: BranchRecord,
    private readonly signal: AbortSignal
  ) {}

  async life(): Promise<void> {
    try {
      await this.open()
      while (!this.signal.aborted) {
        const done = await this.tick()
        if (done) return
        await waitForAbort(TICK_MS, this.signal)
      }
      // The worker is stopping: save the branch for whichever worker claims it next.
      await this.close({})
    } catch (error) {
      if (error instanceof LostBranchError) {
        await this.release()
        return
      }
      console.error(`[SixbAgentWorker] Branch '${this.branch.name}' failed.`, error)
      await this.release()
      await this.write({
        ...STOPPED,
        wanted: "stopped",
        state: "failed",
        error: { message: errorMessage(error) },
      }).catch(() => {})
    }
  }

  /** Returns whether the branch is done with this owner. */
  private async tick(): Promise<boolean> {
    const branch = await this.read()
    const now = Date.now()
    if (branch.wanted === "stopped") {
      await this.close({})
      return true
    }
    if (now - branch.lastSeenAt.getTime() > BRANCH_IDLE_MS) {
      await this.close({ wanted: "stopped" })
      return true
    }
    if ((branch.leaseExpiresAt?.getTime() ?? 0) - now < LEASE_MS / 2) {
      await this.write({ leaseExpiresAt: new Date(now + LEASE_MS) })
    }
    if (now - this.keptAliveAt > KEEP_ALIVE_MS / 2) {
      this.keptAliveAt = now
      await this.sandbox?.keepAlive?.(KEEP_ALIVE_MS).catch((error: unknown) => {
        console.error(`[SixbAgentWorker] Could not keep branch '${branch.name}' alive.`, error)
      })
    }
    if (branch.pushedAt && branch.pushedAt.getTime() > (branch.pulledAt?.getTime() ?? 0)) {
      await this.pull(branch.pushedAt)
    }
    if (this.runtime?.exited) await this.startRuntime()
    await this.report(now)
    return false
  }

  private async open(): Promise<void> {
    const { host, branch } = this
    const recipe = projectSourceEnvironment({
      source: host.source,
      branch: branch.name,
      access: "read",
      base: {
        ...(host.sandboxes.configuration?.env ? { env: host.sandboxes.configuration.env } : {}),
        ...(host.sandboxes.configuration?.network
          ? { network: host.sandboxes.configuration.network }
          : {}),
      },
    })
    const access = new WorkspaceAccess({
      recipe,
      auth: host.sandboxDefinition?.auth,
      factory: host.sandboxes,
      signal: AbortSignal.any([this.signal, this.abort.signal]),
      assertOwner: async () => {
        await this.read()
      },
      onAuthFailure: (error) => {
        console.error(`[SixbAgentWorker] Branch '${branch.name}' lost its source access.`, error)
      },
    })
    this.access = access
    await access.authorize()
    await this.write({ state: "starting", error: null, lastSeenAt: new Date() })

    const session = {
      ...access.sessionOptions,
      requestCredentials: access.requestCredentials,
    }
    const { resume } = host.sandboxes
    let sandbox: Sandbox | undefined
    if (resume && branch.sandbox) {
      try {
        sandbox = sandboxProjectDirectory(
          await resume.call(host.sandboxes, branch.sandbox, session),
          true
        )
        await this.sync(sandbox)
      } catch (error) {
        // Its saved state is gone, or its last session never stopped: start over from the branch.
        console.error(
          `[SixbAgentWorker] Branch '${branch.name}' could not resume; checking it out again.`,
          error
        )
        await sandbox?.stop().catch(() => {})
        sandbox = undefined
      }
    }
    if (!sandbox) {
      const name = resume ? createAgentThreadSandboxName(host.id, `branch:${branch.name}`) : null
      // Written first, so a crash during creation still names what it left behind.
      await this.write({ sandbox: name })
      sandbox = await host.sandboxes.create({
        ...session,
        signal: this.signal,
        environment: { source: recipe.source, setup: recipe.setup },
        ports: [branch.port],
        ...(name ? { persistence: { name } } : {}),
      })
    }
    this.sandbox = sandbox
    access.attach(sandbox)

    if (!sandbox.start || !sandbox.url) {
      throw new Error(
        `[SixbAgentWorker] The sandbox provider '${sandbox.provider}' can't serve a branch: it needs start and url.`
      )
    }
    this.url = sandbox.url(branch.port)
    await this.startRuntime()
    await this.write({ url: this.url })
  }

  private async startRuntime(): Promise<void> {
    const { sandbox, branch } = this
    if (!sandbox?.start) return
    const process = await sandbox.start("sh", ["-c", BRANCH_RUNTIME_COMMAND], {
      cwd: this.host.source.path ?? ".",
      env: {
        [BRANCH_KEY_ENV]: branch.key,
        SIXB_BRANCH_NAME: branch.name,
        SIXB_BRANCH_PORT: String(branch.port),
      },
    })
    const runtime = { process, exited: false }
    this.runtime = runtime
    this.startedAt = Date.now()
    void process.exited.then(() => {
      runtime.exited = true
    })
  }

  /** Makes the checkout the branch as it is on the remote, whatever the checkout held. */
  private async sync(sandbox: Sandbox): Promise<void> {
    const result = await sandbox.runCommand(
      "sh",
      ["-c", 'git fetch --quiet origin "$SIXB_BRANCH_NAME" && git reset --quiet --hard FETCH_HEAD'],
      { env: { SIXB_BRANCH_NAME: this.branch.name }, timeout: 120_000, signal: this.signal }
    )
    if (result.exitCode !== 0) {
      throw new Error(
        `[SixbAgentWorker] Could not update branch '${this.branch.name}': ${result.stderr.trim()}`
      )
    }
  }

  private async pull(pushedAt: Date): Promise<void> {
    if (!this.sandbox) return
    try {
      await this.sync(this.sandbox)
    } catch (error) {
      console.error(errorMessage(error))
    }
    // The runtime's watcher restarts it on what changed: its status reports the new generation.
    await this.write({ pulledAt: pushedAt })
  }

  /** Writes what the runtime's front reports. */
  private async report(now: number): Promise<void> {
    const { url, branch } = this
    if (!url) return
    const status = await fetch(new URL(BRANCH_STATUS_PATH, url), {
      headers: { [BRANCH_KEY_HEADER]: branch.key },
      signal: AbortSignal.timeout(5_000),
    })
      .then(async (response) => parseBranchRuntimeStatus(await response.json()))
      .catch(() => null)

    if (!status) {
      if (now - this.startedAt > ANSWER_DEADLINE_MS && branch.state !== "failed") {
        await this.write({
          state: "failed",
          manifest: null,
          error: { message: "The branch's runtime stopped answering." },
        })
      }
      return
    }
    const changes: BranchChanges = {
      state: status.state,
      generation: status.generation,
      commit: status.commit,
      manifest: status.manifest,
      error: status.error,
    }
    const changed = (Object.keys(changes) as (keyof typeof changes)[]).some(
      (key) => JSON.stringify(changes[key]) !== JSON.stringify(branch[key])
    )
    if (changed) await this.write(changes)
  }

  /** Stops the runtime and saves the sandbox, then lets the branch go. */
  private async close(changes: BranchChanges): Promise<void> {
    await this.runtime?.process.kill().catch(() => {})
    await this.access?.close().catch((error: unknown) => {
      console.error(`[SixbAgentWorker] Branch '${this.branch.name}' kept a grant.`, error)
    })
    if (this.sandbox) {
      await this.sandbox.stop()
      if (!this.host.sandboxes.resume) await this.sandbox.destroy()
    }
    this.abort.abort()
    await this.write({ ...STOPPED, ...changes })
  }

  /** Drops this worker's hold without touching the sandbox's saved state. */
  private async release(): Promise<void> {
    this.abort.abort()
    await this.runtime?.process.kill().catch(() => {})
    await this.access?.close().catch(() => {})
    await this.sandbox?.stop().catch(() => {})
    if (!this.host.sandboxes.resume) await this.sandbox?.destroy().catch(() => {})
  }

  /** The branch as stored, while this worker still holds it. */
  private async read(): Promise<BranchRecord> {
    const branch = await this.host.branches.get({
      projectId: this.host.id,
      name: this.branch.name,
    })
    if (!branch || branch.owner !== this.owner) throw new LostBranchError()
    this.branch = branch
    return branch
  }

  /** Writes over what this worker last read, reading again when only someone's visit moved it on. */
  private async write(changes: BranchChanges): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const written = await this.host.branches.update(
        {
          projectId: this.host.id,
          name: this.branch.name,
          revision: this.branch.revision,
          at: new Date(),
        },
        changes
      )
      if (written) {
        this.branch = written
        return
      }
      await this.read()
    }
    throw new Error(`[SixbAgentWorker] Branch '${this.branch.name}' kept changing under its owner.`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
