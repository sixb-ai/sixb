import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ComputerRunner } from "@sixb/agent"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { resolveConfigPath } from "../lib/profiles"
import type { Connection } from "./connection"

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
    connection: Connection,
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
