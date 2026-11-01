import { randomUUID } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ComputerRunner } from "@sixb/agent"
import {
  type GetAgentThreadResponses,
  getAgentRun,
  getAgentThread,
  holdAgentComputerSession,
  releaseAgentComputerSession,
} from "@sixb/client"
import type { ConversationAgentRunRecord } from "@sixb/core/storage"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { resolveConfigPath } from "../lib/profiles"
import { thisComputer, thisComputerId } from "./computer"
import type { Connection } from "./connection"

/** How long a closed terminal waits for a turn running here to record its end. */
const HANG_UP_WAIT_MS = 10_000
/** How often an open `sixb` renews its session, which lapses a minute after its last renewal. */
const SESSION_RENEW_MS = 20_000

/**
 * What the agent's commands never read on this computer, whatever the folder: the CLI's own
 * sign-in, and the credentials SSH and AWS keep.
 */
export function deniedPaths(): readonly string[] {
  return [dirname(resolveConfigPath()), join(homedir(), ".ssh"), join(homedir(), ".aws")]
}

/**
 * This computer as a runner: it claims its owner's turns from the project and runs them in the
 * folder `sixb` was opened in, one at a time per turn, each until it ends or is stopped. While its
 * session is open, the project knows `sixb` is open here, and the turns sent from elsewhere to the
 * conversations of this folder run here too.
 */
export class LocalRunner {
  private readonly runner: ComputerRunner
  private readonly running = new Map<
    string,
    { readonly stop: AbortController; readonly done: Promise<boolean> }
  >()
  private readonly elsewhereListeners = new Set<(run: ConversationAgentRunRecord) => void>()
  private session: { readonly id: string; readonly timer: ReturnType<typeof setInterval> } | null =
    null
  /** The session's last call: its release follows a renewal, which would open it again. */
  private lastCall: Promise<void> = Promise.resolve()

  constructor(
    private readonly connection: Connection,
    /** The folder `sixb` was opened in: its real path, as the project keeps it. */
    readonly folder: string,
    private readonly onFailure: (error: unknown) => void
  ) {
    this.runner = new ComputerRunner({
      apiUrl: connection.apiUrl,
      authorization: () => connection.authorization(),
      computer: thisComputer,
      folder,
      runFilesRoot: join(tmpdir(), "sixb-agent"),
      onFailure,
      openSandbox: ({ workingDirectory, runFiles, credential, signal }) =>
        new LocalSandboxFactory({
          readWritePaths: [runFiles],
          denyReadPaths: deniedPaths(),
          network: { mode: "all" },
        }).create({
          ...(workingDirectory === undefined ? {} : { workingDirectory }),
          network: { mode: "all" },
          requestCredentials: [credential],
          signal,
        }),
    })
  }

  /** Hear each turn sent from elsewhere as it starts to run here. Returns the unsubscribe. */
  onElsewhere(listener: (run: ConversationAgentRunRecord) => void): () => void {
    this.elsewhereListeners.add(listener)
    return () => this.elsewhereListeners.delete(listener)
  }

  /** Whether this computer runs `runId` now. */
  runs(runId: string): boolean {
    return this.running.has(runId)
  }

  /**
   * Claim a queued turn and run it, unless this computer runs it already. Resolves once the turn
   * ended here: false when it was not this computer's to run, or could not be claimed.
   */
  claim(runId: string, onClaimed?: (run: ConversationAgentRunRecord) => void): Promise<boolean> {
    const running = this.running.get(runId)
    if (running) return running.done
    const stop = new AbortController()
    const done = this.runner
      .runTurn(runId, stop.signal, onClaimed)
      .catch((error: unknown) => {
        this.onFailure(error)
        return false
      })
      .finally(() => this.running.delete(runId))
    this.running.set(runId, { stop, done })
    return done
  }

  /**
   * Hold this `sixb`'s session while it is open: the conversations of this folder read as online,
   * and the turns waiting for them are claimed. Idempotent.
   */
  openSession(): void {
    if (this.session) return
    const id = `cs_${randomUUID()}`
    const hold = async () => {
      const { data, error } = await holdAgentComputerSession({
        client: this.connection.client,
        path: { sessionId: id },
        body: { computer: { ...(await thisComputer()), folder: this.folder } },
      })
      if (error) throw error
      // Closed meanwhile, with the setting or by quitting: what waits keeps waiting.
      if (this.session?.id !== id) return
      for (const runId of data?.waiting ?? []) void this.claimElsewhere(runId)
    }
    // A missed renewal is retried at the next; the session lasts three of them.
    const renew = () => {
      this.lastCall = hold().catch((error: unknown) =>
        console.error("[SixbCLI] Session renewal failed.", error)
      )
    }
    this.session = { id, timer: setInterval(renew, SESSION_RENEW_MS) }
    renew()
  }

  /** Close the session: the conversations of this folder read as offline at once. */
  async closeSession(): Promise<void> {
    const session = this.session
    if (session) {
      this.session = null
      clearInterval(session.timer)
      // Whoever closes it next waits for this one, as quitting does after the screen let go.
      this.lastCall = this.lastCall
        .then(() =>
          releaseAgentComputerSession({
            client: this.connection.client,
            path: { sessionId: session.id },
          })
        )
        .then(
          () => {},
          () => {}
        )
    }
    await this.lastCall
  }

  /**
   * Claim a turn sent from elsewhere when this computer runs its conversation: its owner's, on this
   * computer and in this folder, and still queued, while the session is open. A running turn is
   * another sixb's, or one whose sixb closed, which the API ends interrupted: claiming it again
   * would run its commands twice.
   */
  async claimIfHere(threadId: string, runId?: string): Promise<void> {
    if (!this.session || (runId && this.running.has(runId))) return
    const { client } = this.connection
    const { data: thread } = await getAgentThread({ client, path: { threadId } })
    if (!thread || !this.runsHere(thread, await thisComputerId())) return

    const turn = runId ?? thread.activeRunId
    if (!turn) return
    const { data: run } = await getAgentRun({ client, path: { runId: turn } })
    if (run?.status === "queued" && this.session) void this.claimElsewhere(turn)
  }

  /** Whether this `sixb` runs `thread`'s turns: its owner's, on this computer, in this folder. */
  runsHere(thread: GetAgentThreadResponses[200], computerId: string): boolean {
    return (
      thread.runsOn === "computer" &&
      owns(this.connection, thread) &&
      thread.computer?.id === computerId &&
      thread.computer.folder === this.folder
    )
  }

  /** After a stop was asked for: the turn hears it now, not at its next lease renewal. */
  hearStop(runId: string): void {
    this.runner.renewNow(runId)
  }

  /** Whether a turn runs here now. */
  get busy(): boolean {
    return this.running.size > 0
  }

  /**
   * Stop every turn this computer runs, each ending interrupted with its end recorded, and close
   * the session.
   */
  async stop(): Promise<void> {
    const running = [...this.running.values()]
    for (const { stop } of running) stop.abort()
    await Promise.allSettled([...running.map(({ done }) => done), this.closeSession()])
    await this.runner.drain()
  }

  /** A turn this computer already runs joins that run, and is no news. */
  private claimElsewhere(runId: string): Promise<boolean> {
    return this.claim(runId, (run) => {
      for (const listener of this.elsewhereListeners) listener(run)
    })
  }
}

/** Whether the person signed in owns `thread`: with sign-in off, the system owns what it starts. */
export function owns(
  connection: Pick<Connection, "user">,
  thread: Pick<GetAgentThreadResponses[200], "ownerPrincipal">
): boolean {
  const owner = thread.ownerPrincipal
  return connection.user
    ? owner.type === "user" && owner.id === connection.user.id
    : owner.type === "system"
}

/**
 * A closed terminal, or a kill, ends sixb as quitting does: the turns running here stop, each
 * ending interrupted with its end recorded, instead of renewing their lease from a process nobody
 * sees, and the session closes. Then `exit`, after a bounded wait. Returns the removal of the
 * handlers.
 */
export function stopOnHangUp(
  runner: () => Pick<LocalRunner, "stop"> | null,
  exit: (signal: "SIGHUP" | "SIGTERM") => void
): () => void {
  const hangUp = (signal: "SIGHUP" | "SIGTERM") => {
    const running = runner()
    if (!running) return exit(signal)

    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, HANG_UP_WAIT_MS)
    })
    void Promise.race([running.stop(), waited]).finally(() => {
      clearTimeout(timer)
      exit(signal)
    })
  }

  const onHangUp = () => hangUp("SIGHUP")
  const onTerminate = () => hangUp("SIGTERM")
  process.on("SIGHUP", onHangUp)
  process.on("SIGTERM", onTerminate)
  return () => {
    process.off("SIGHUP", onHangUp)
    process.off("SIGTERM", onTerminate)
  }
}
