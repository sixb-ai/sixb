import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ComputerRunner } from "@sixb/agent"
import { type GetAgentThreadResponses, getAgentRun, getAgentThread } from "@sixb/client"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { resolveConfigPath } from "../lib/profiles"
import type { Connection } from "./connection"
import { folderOf } from "./folders"

/** How long a closed terminal waits for a turn running here to record its end. */
const HANG_UP_WAIT_MS = 10_000

/**
 * What the agent's commands never read on this computer, whatever the folder: the CLI's own
 * sign-in, and the credentials SSH and AWS keep.
 */
export function deniedPaths(): readonly string[] {
  return [dirname(resolveConfigPath()), join(homedir(), ".ssh"), join(homedir(), ".aws")]
}

/**
 * This computer as a runner: it claims its owner's turns from the project and runs them in the
 * folder `sixb` was opened in, one at a time per turn, each until it ends or is stopped.
 */
export class LocalRunner {
  private readonly runner: ComputerRunner
  private readonly running = new Map<
    string,
    { readonly stop: AbortController; readonly done: Promise<boolean> }
  >()

  constructor(
    private readonly connection: Connection,
    readonly folder: string,
    private readonly onFailure: (error: unknown) => void
  ) {
    this.runner = new ComputerRunner({
      apiUrl: connection.apiUrl,
      authorization: () => connection.authorization(),
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

  /** Whether this computer runs `runId` now. */
  runs(runId: string): boolean {
    return this.running.has(runId)
  }

  /**
   * Claim a queued turn and run it, unless this computer runs it already. Resolves once the turn
   * ended here: false when it was not this computer's to run, or could not be claimed.
   */
  claim(runId: string): Promise<boolean> {
    const running = this.running.get(runId)
    if (running) return running.done
    const stop = new AbortController()
    const done = this.runner
      .runTurn(runId, stop.signal)
      .catch((error: unknown) => {
        this.onFailure(error)
        return false
      })
      .finally(() => this.running.delete(runId))
    this.running.set(runId, { stop, done })
    return done
  }

  /**
   * Claim a conversation's turn when this computer runs it: its owner's, in this folder, and still
   * queued. A running turn is another sixb's, or one whose sixb closed, which the API ends
   * interrupted: claiming it again would run its commands twice.
   */
  async claimIfHere(threadId: string, runId?: string): Promise<void> {
    if ((await folderOf(threadId)) !== this.folder) return
    const { client } = this.connection
    const { data: thread } = await getAgentThread({ client, path: { threadId } })
    if (thread?.runsOn !== "computer" || !owns(this.connection, thread)) return

    const turn = runId ?? thread.activeRunId
    if (!turn) return
    const { data: run } = await getAgentRun({ client, path: { runId: turn } })
    if (run?.status === "queued") void this.claim(turn)
  }

  /** After a stop was asked for: the turn hears it now, not at its next lease renewal. */
  hearStop(runId: string): void {
    this.runner.renewNow(runId)
  }

  /** Whether a turn runs here now. */
  get busy(): boolean {
    return this.running.size > 0
  }

  /** Stop every turn this computer runs: each ends interrupted, its end recorded. */
  async stop(): Promise<void> {
    const running = [...this.running.values()]
    for (const { stop } of running) stop.abort()
    await Promise.allSettled(running.map(({ done }) => done))
    await this.runner.drain()
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
 * sees. Then `exit`, after a bounded wait. Returns the removal of the handlers.
 */
export function stopOnHangUp(
  runner: () => Pick<LocalRunner, "busy" | "stop"> | null,
  exit: (signal: "SIGHUP" | "SIGTERM") => void
): () => void {
  const hangUp = (signal: "SIGHUP" | "SIGTERM") => {
    const running = runner()
    if (!running?.busy) return exit(signal)

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
