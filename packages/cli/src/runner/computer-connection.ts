import { stat } from "node:fs/promises"
import { createAgentActivitySocket, getAgentThread, isSixbApiError } from "@sixb/client"
import type { Connection } from "../lib/connection"
import { readAllowedFolders, watchAllowedFolders } from "./allowed-folders"
import { LocalRunner } from "./local-runner"

/** How often the allowed folders are checked for being there still. */
const FOLDER_RECHECK_MS = 20_000

/** What a connected computer reports, one line each with `sixb connect --json`. */
export type ComputerEvent =
  | { readonly type: "folders"; readonly folders: readonly string[] }
  | {
      readonly type: "turn.started"
      readonly folder: string
      readonly threadId: string
      readonly runId: string
    }
  | {
      readonly type: "turn.ended"
      readonly folder: string
      readonly threadId: string
      readonly runId: string
      /** False when it could not be claimed or failed before it ended on its own. */
      readonly ran: boolean
    }
  | { readonly type: "session.lost"; readonly folder: string; readonly message: string }
  | { readonly type: "session.back"; readonly folder: string }
  | { readonly type: "signed-out" }
  | { readonly type: "error"; readonly message: string }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * This computer, connected: one session per allowed folder, and the turns sent to their
 * conversations run in their folders. The list of folders is read again whenever it changes, so
 * choosing one needs no restart.
 */
export class ComputerConnection {
  private readonly runners = new Map<string, LocalRunner>()
  private socket: { close(): void } | null = null
  private unwatch: (() => void) | null = null
  private recheck: ReturnType<typeof setInterval> | null = null
  private reconciled: Promise<void> = Promise.resolve()
  private shown: readonly string[] | null = null
  private stopped = false

  constructor(
    private readonly connection: Connection,
    private readonly onEvent: (event: ComputerEvent) => void,
    private readonly keepsAwake: boolean
  ) {}

  async start(): Promise<void> {
    this.unwatch = await watchAllowedFolders(() => void this.reconcile())
    await this.reconcile()
    // A folder can go or come back with no change to the list: a deleted one, an unmounted volume.
    this.recheck = setInterval(() => void this.reconcile(), FOLDER_RECHECK_MS)
    this.socket = createAgentActivitySocket({
      client: this.connection.client,
      onActivity: (event) => {
        // Queued turns only reach here by this event for speed: each renewal lists them too.
        if (event.status !== "queued" || event.runsOn !== "computer") return
        void this.route(event.threadId, event.runId).catch((error: unknown) =>
          this.onEvent({ type: "error", message: messageOf(error) })
        )
      },
    })
  }

  /** Stop every turn running here, each ending interrupted, and close every session. */
  async stop(): Promise<void> {
    this.stopped = true
    this.socket?.close()
    this.unwatch?.()
    if (this.recheck) clearInterval(this.recheck)
    // Not after `reconciled`: a stalled call there mustn't keep a turn from hearing its stop.
    await Promise.allSettled([...this.runners.values()].map((runner) => runner.stop()))
  }

  /** One at a time, so two quick changes can't leave the older read in charge. */
  private reconcile(): Promise<void> {
    this.reconciled = this.reconciled.then(() => this.applyAllowedFolders())
    return this.reconciled
  }

  private async applyAllowedFolders(): Promise<void> {
    if (this.stopped) return
    const folders = await this.existing(await this.readAllowed())
    if (this.stopped) return

    for (const folder of folders) this.runnerFor(folder).openSession()
    for (const [folder, runner] of this.runners) {
      // Not awaited: a stalled call there mustn't keep the next change from being applied.
      if (!folders.includes(folder)) void runner.closeSession()
    }

    if (folders.join("\n") !== this.shown?.join("\n")) {
      this.shown = folders
      this.onEvent({ type: "folders", folders })
    }
  }

  /** A list that can't be read allows nothing, and says so. */
  private async readAllowed(): Promise<readonly string[]> {
    try {
      return await readAllowedFolders()
    } catch (error) {
      this.onEvent({ type: "error", message: messageOf(error) })
      return []
    }
  }

  /** A folder that's gone reads as offline, rather than as one whose turns all fail. */
  private async existing(folders: readonly string[]): Promise<readonly string[]> {
    const found = await Promise.all(
      folders.map((folder) =>
        stat(folder).then(
          (entry) => entry.isDirectory(),
          () => false
        )
      )
    )
    return folders.filter((_folder, index) => found[index])
  }

  private runnerFor(folder: string): LocalRunner {
    const known = this.runners.get(folder)
    if (known) return known

    const runner = new LocalRunner(
      this.connection,
      folder,
      (error) => this.onEvent({ type: "error", message: messageOf(error) }),
      { onSessionChange: (failure) => this.onSessionChange(folder, failure) }
    )
    runner.keepsAwake = this.keepsAwake
    runner.onElsewhere((run, ended) => {
      const turn = { folder, threadId: run.threadId, runId: run.id }
      this.onEvent({ type: "turn.started", ...turn })
      void ended.then((ran) => this.onEvent({ type: "turn.ended", ...turn, ran }))
    })
    this.runners.set(folder, runner)
    return runner
  }

  private onSessionChange(folder: string, failure: unknown | null): void {
    if (failure === null) {
      this.onEvent({ type: "session.back", folder })
    } else if (isSixbApiError(failure) && failure.status === 401) {
      this.onEvent({ type: "signed-out" })
    } else {
      this.onEvent({ type: "session.lost", folder, message: messageOf(failure) })
    }
  }

  /** Each folder's runner would read the thread to learn it isn't theirs: read it once. */
  private async route(threadId: string, runId: string): Promise<void> {
    const { data: thread } = await getAgentThread({
      client: this.connection.client,
      path: { threadId },
    })
    const folder = thread?.computer?.folder
    if (thread && folder) await this.runners.get(folder)?.offer(thread, runId)
  }
}
