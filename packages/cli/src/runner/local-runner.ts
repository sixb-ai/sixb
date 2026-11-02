import { randomUUID } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  type ComputerBackgroundCommand,
  type ComputerBackgroundCommandRef,
  ComputerRunner,
} from "@sixb/agent"
import {
  type GetAgentThreadResponses,
  getAgentRun,
  getAgentThread,
  holdAgentComputerSession,
  releaseAgentComputerSession,
} from "@sixb/client"
import type { ConversationAgentRunRecord } from "@sixb/core/storage"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import type { Connection } from "../lib/connection"
import { resolveConfigPath } from "../lib/profiles"
import { thisComputer, thisComputerId } from "./computer"
import { keepAwake, type ReleaseAwake } from "./keep-awake"

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

/** The project refused a session's renewal, as opposed to being out of reach. */
export class SessionRefusedError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "SessionRefusedError"
  }
}

export interface LocalRunnerOptions {
  /** The session stopped renewing, or started again. Called when that changes, not each time. */
  readonly onSessionChange?: (failure: unknown | null) => void
  /** How a running turn keeps the computer awake. By default, `keepAwake`. */
  readonly holdAwake?: () => ReleaseAwake
}

/**
 * This computer as a runner: it claims its owner's turns from the project and runs them in one
 * folder, each until it ends or is stopped. While its session is open, the project knows `sixb` is
 * open here, and the turns sent from elsewhere to the conversations of this folder run here too, one
 * at a time: nobody may be watching, and two turns would edit the same files.
 */
export class LocalRunner {
  private readonly runner: ComputerRunner
  private readonly running = new Map<
    string,
    { readonly stop: AbortController; readonly done: Promise<boolean> }
  >()
  private readonly elsewhereListeners = new Set<
    (run: ConversationAgentRunRecord, ended: Promise<boolean>) => void
  >()
  private readonly backgroundListeners = new Set<() => void>()
  private session: {
    readonly id: string
    readonly timer: ReturnType<typeof setInterval>
    readonly renew: () => void
  } | null = null
  private sessionFailing = false
  /** Whether a running turn keeps the computer awake: the person's setting. */
  keepsAwake = true
  /** The session's last call: its release follows a renewal, which would open it again. */
  private lastCall: Promise<void> = Promise.resolve()

  constructor(
    private readonly connection: Connection,
    /** The folder `sixb` was opened in: its real path, as the project keeps it. */
    readonly folder: string,
    private readonly onFailure: (error: unknown) => void,
    private readonly options: LocalRunnerOptions = {}
  ) {
    this.runner = new ComputerRunner({
      apiUrl: connection.apiUrl,
      authorization: () => connection.authorization(),
      computer: thisComputer,
      folder,
      runFilesRoot: join(tmpdir(), "sixb-agent"),
      onFailure,
      // The web shows a command start and end at once, and so does the screen.
      onBackgroundChange: () => {
        this.session?.renew()
        for (const listener of this.backgroundListeners) listener()
      },
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
  onElsewhere(
    listener: (run: ConversationAgentRunRecord, ended: Promise<boolean>) => void
  ): () => void {
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
    const holdAwake = this.options.holdAwake ?? keepAwake.hold
    const releaseAwake = this.keepsAwake ? holdAwake() : null
    const done = this.runner
      .runTurn(runId, stop.signal, onClaimed)
      .catch((error: unknown) => {
        this.onFailure(error)
        return false
      })
      .finally(() => {
        this.running.delete(runId)
        releaseAwake?.()
      })
    // What waited for this turn runs now, not at the next renewal. Only after one that ran: one that
    // couldn't be claimed may be listed again, and asking at once would ask forever.
    void done.then((ran) => {
      if (ran) this.session?.renew()
    })
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
      // Read as it is sent, so a renewal that waited its turn reports the commands as they are.
      const backgroundCommands = this.runner.backgroundCommands()
      const { data, error, response } = await holdAgentComputerSession({
        client: this.connection.client,
        path: { sessionId: id },
        body: {
          computer: { ...(await thisComputer()), folder: this.folder },
          ...(backgroundCommands.length > 0 ? { backgroundCommands: [...backgroundCommands] } : {}),
        },
      })
      // No response is a network failure, which says what's wrong better than a refusal would.
      if (error)
        throw response ? new SessionRefusedError(response.status, refusalText(error)) : error
      this.noteSession(null)
      // Closed meanwhile, with the setting or by quitting: what waits keeps waiting.
      if (this.session?.id !== id) return
      for (const runId of data?.waiting ?? []) void this.claimElsewhere(runId)
      for (const ref of data?.stop ?? []) void this.stopBackground(ref)
    }

    // One renewal at a time, in order, so an older report never lands after a newer one; one
    // asked for while another waits its turn is that one. A missed renewal is retried at the
    // next; the session lasts three of them.
    let queued = false
    const renew = () => {
      if (queued) return
      queued = true
      this.lastCall = this.lastCall
        .then(() => {
          queued = false
          return hold()
        })
        .catch((error: unknown) => this.noteSession(error))
    }
    this.session = { id, timer: setInterval(renew, SESSION_RENEW_MS), renew }
    renew()
  }

  /**
   * Renew the session now rather than at its next renewal, when the project says something
   * changed for this folder: a stop asked for from the web is in the answer.
   */
  renewSession(): void {
    this.session?.renew()
  }

  /** This folder's background commands, by thread: the running ones, then the latest to end. */
  backgroundCommands(threadId?: string): readonly ComputerBackgroundCommand[] {
    const all = this.runner.backgroundCommands()
    return threadId === undefined ? all : all.filter((command) => command.threadId === threadId)
  }

  /** Hear each background command start and end. Returns the unsubscribe. */
  onBackground(listener: () => void): () => void {
    this.backgroundListeners.add(listener)
    return () => this.backgroundListeners.delete(listener)
  }

  /**
   * Stop a background command, and everything it started, as the agent's `bash_stop` does. False
   * when it ended already, or is not this `sixb`'s.
   */
  async stopBackground(ref: ComputerBackgroundCommandRef): Promise<boolean> {
    try {
      return await this.runner.stopBackgroundCommand(ref)
    } catch (error) {
      this.onFailure(error)
      return false
    }
  }

  /** Close the session: the conversations of this folder read as offline at once. */
  async closeSession(): Promise<void> {
    const session = this.session
    if (session) {
      this.session = null
      this.sessionFailing = false
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
    if (thread) await this.offer(thread, runId)
  }

  /** As `claimIfHere`, for a caller that has read the thread already. */
  async offer(thread: GetAgentThreadResponses[200], runId?: string): Promise<void> {
    if (!this.session || !this.runsHere(thread, await thisComputerId())) return

    const turn = runId ?? thread.activeRunId
    if (!turn) return
    const { client } = this.connection
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

  /** Whether a background command a turn started here runs now. */
  get runsBackgroundCommands(): boolean {
    return this.runner.runsBackgroundCommands
  }

  /**
   * Stop every turn this computer runs, each ending interrupted with its end recorded, and the
   * background commands they left running, and close the session.
   */
  async stop(): Promise<void> {
    const running = [...this.running.values()]
    for (const { stop } of running) stop.abort()
    await Promise.allSettled([...running.map(({ done }) => done), this.closeSession()])
    await this.runner.stopBackgroundCommands()
    await this.runner.drain()
  }

  /**
   * Claim a turn sent from elsewhere, and say so. Left waiting while a turn runs here: it runs once
   * that one ends, or at a later renewal.
   */
  claimElsewhere(runId: string): Promise<boolean> {
    if (this.running.size > 0) return Promise.resolve(false)
    return this.claim(runId, (run) => {
      const ended = this.running.get(run.id)?.done ?? Promise.resolve(false)
      for (const listener of this.elsewhereListeners) listener(run, ended)
    })
  }

  private noteSession(failure: unknown | null): void {
    if ((failure !== null) === this.sessionFailing) return
    this.sessionFailing = failure !== null
    if (this.options.onSessionChange) this.options.onSessionChange(failure)
    else if (failure !== null) this.onFailure(failure)
  }
}

function refusalText(error: unknown): string {
  const message = (error as { readonly error?: unknown } | null)?.error
  return typeof message === "string" ? message : "[SixbCLI] The project refused this session."
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
 * Quitting `sixb`: the turns running here end interrupted, their end recorded, the background
 * commands they left stop, and the session closes, within `waitMs`, whether a turn runs or not.
 * `note` says what it waits for.
 */
export async function stopOnQuit(
  runner: Pick<LocalRunner, "busy" | "runsBackgroundCommands" | "stop">,
  waitMs: number,
  note: (text: string) => void
): Promise<void> {
  if (runner.busy) note("Stopping the turn running here…")
  else if (runner.runsBackgroundCommands) note("Stopping the background commands running here…")

  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    runner.stop(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs)
    }),
  ])
  clearTimeout(timer)
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
