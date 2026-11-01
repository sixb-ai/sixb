import { mkdir, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import type { Sandbox, SandboxRequestCredential } from "@sixb/core"
import {
  AgentExecutionLostError,
  AgentRunRefusedError,
  type AgentRunSession,
  claimAgentRunChildOverHttp,
  claimAgentRunOverHttp,
  type HttpAgentRunSessionInput,
} from "@sixb/core/internal/agents"
import type { ConversationAgentRunRecord } from "@sixb/core/storage"
import { delay } from "./abort"
import { ChildRunner } from "./run-child"
import { runConversationTurn } from "./run-conversation-turn"
import { runApiCredential, runnerTokenFor, runTokenFor } from "./run-credential"
import type { OpenRunSandbox } from "./run-environment"
import { holdRunFiles } from "./run-files-lock"
import type { RunSandbox } from "./run-sandbox"
import type { AgentRunSettings } from "./types"

// A turn on its owner's computer: claimed over HTTP as them, run in their folder, its children
// beside it. The API does everything a turn asks of its project; the computer runs its commands.

/** Opens the sandbox a computer's run works in. */
export type OpenComputerSandbox = (input: {
  /** The user's folder, for a turn; absent for a child, which works in a folder of its own. */
  readonly workingDirectory?: string
  /** Where the run's own files go, outside the folder: its commands may write there too. */
  readonly runFiles: string
  /** The run's token, which the sandbox adds outside its commands. */
  readonly credential: SandboxRequestCredential
  readonly signal: AbortSignal
}) => Promise<Sandbox>

export interface ComputerRunnerOptions {
  /** The project's API origin. */
  readonly apiUrl: string
  /** The user's own credential, as an `Authorization` header value, read for each claim. */
  authorization(): Promise<string>
  /**
   * This computer's id, which each claim names: a thread runs on one of its owner's computers, and
   * only that one claims its turns.
   */
  computerId(): Promise<string>
  /** The folder the user's turns work in. */
  readonly folder: string
  /**
   * Where each run's own files go: a directory per thread, so every turn's prompt names the same
   * paths, emptied when a run starts and removed when it ends. Shared by every runner on the
   * computer, which hold a thread's directory one run at a time.
   */
  readonly runFilesRoot: string
  readonly openSandbox: OpenComputerSandbox
  /** How many children of one turn run at once. Defaults to 4. */
  readonly childCapacity?: number
  /** A run that failed, once its end is recorded. */
  readonly onFailure?: (error: unknown) => void
  readonly fetch?: (request: Request) => Promise<Response>
}

/** How far ahead a lease is held, and how often it is renewed: a renewal also hears a cancel. */
const LEASE_MS = 60_000
const RENEW_MS = 10_000
const CHILD_CLAIM_RETRIES = 5

export class ComputerRunner {
  private readonly teardowns = new Set<Promise<void>>()
  /** Each running turn's renewal, by run id, to renew at once. */
  private readonly renewals = new Map<string, () => void>()

  constructor(private readonly options: ComputerRunnerOptions) {}

  /**
   * Claim a queued turn and run it to its end. False when it was not this computer's to run: it
   * ended already, or another runner holds it. `signal` stops the runner: the turn ends
   * interrupted, its end recorded.
   */
  async runTurn(runId: string, signal: AbortSignal): Promise<boolean> {
    const { apiUrl } = this.options
    const fetch = this.options.fetch
    const session = await claimAgentRunOverHttp({
      apiUrl,
      runId,
      authorization: await this.options.authorization(),
      computerId: await this.options.computerId(),
      leaseExpiresAt: lease(),
      ...(fetch === undefined ? {} : { fetch }),
    })
    if (!session) return false

    const { run } = session
    const turn: HttpAgentRunSessionInput<ConversationAgentRunRecord> = {
      apiUrl,
      runnerToken: runnerTokenFor({
        projectId: run.projectId,
        runId: run.id,
        executionToken: session.executionToken,
      }),
      run,
      ...(fetch === undefined ? {} : { fetch }),
    }
    const lost = new AbortController()
    const held = new Set<AgentRunSession>([session])
    const renewing = this.renew(held, session, lost)
    this.renewals.set(run.id, renewing.now)
    const turnSignal = AbortSignal.any([signal, lost.signal])
    const settings = computerSettings(run.projectId, apiUrl)
    const children = this.childRunner(turn, settings)

    try {
      await runConversationTurn({
        session,
        signal: turnSignal,
        runner: {
          settings,
          openSandbox: () =>
            this.sandbox({
              runId: run.id,
              threadId: run.threadId,
              executionToken: session.executionToken,
              projectId: run.projectId,
              folder: this.options.folder,
            }),
          startChild: (child, family) =>
            children.start(child, {
              signal: turnSignal,
              family,
              leaseExpiresAt: lease,
              holdLease: async (childSession) => {
                held.add(childSession)
                try {
                  await childSession.renewLease(lease())
                } catch (error) {
                  held.delete(childSession)
                  throw error
                }
                return () => held.delete(childSession)
              },
            }),
          onDetachedTeardown: (teardown) => this.track(teardown),
          reportFailure: (error) => this.options.onFailure?.(error),
        },
      })
    } catch (error) {
      // Stopped with its end recorded: nothing to release, as no queue holds it.
      if (!turnSignal.aborted) throw error
    } finally {
      await children.stopChildrenOf(run.id)
      this.renewals.delete(run.id)
      renewing.stop()
      await session.close()
    }
    return true
  }

  /**
   * Renew a running turn's lease now rather than at its next renewal: its answer carries a cancel
   * just asked for, so a stop from this computer takes effect at once.
   */
  renewNow(runId: string): void {
    this.renewals.get(runId)?.()
  }

  /** Wait for sandbox teardowns that outlived their runs. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.teardowns])
  }

  /**
   * Renew the turn's lease, and its children's, until stopped. A renewal answers a cancel; one
   * that finds the turn no longer this computer's stops it.
   */
  private renew(
    held: Set<AgentRunSession>,
    turn: AgentRunSession,
    lost: AbortController
  ): { now(): void; stop(): void } {
    const renew = () => {
      for (const session of held) {
        void session.renewLease(lease()).catch((error: unknown) => {
          if (error instanceof AgentExecutionLostError) {
            held.delete(session)
            if (session === turn) lost.abort(error)
            return
          }
          // A blip: the next renewal tries again, well before the lease runs out.
          console.error(`[SixbAgent] Could not renew run '${session.run.id}'.`, error)
        })
      }
    }
    const timer = setInterval(renew, RENEW_MS)
    return { now: renew, stop: () => clearInterval(timer) }
  }

  private childRunner(
    turn: HttpAgentRunSessionInput<ConversationAgentRunRecord>,
    settings: AgentRunSettings
  ): ChildRunner {
    return new ChildRunner({
      settings,
      capacity: this.options.childCapacity ?? 4,
      claim: async (run, { leaseExpiresAt, stop }) => {
        for (let retry = 0; ; retry += 1) {
          try {
            return await claimAgentRunChildOverHttp(turn, { childRunId: run.id, leaseExpiresAt })
          } catch (error) {
            if (error instanceof AgentRunRefusedError || error instanceof AgentExecutionLostError) {
              return null
            }
            if (retry >= CHILD_CLAIM_RETRIES) throw error
          }
          if (stop.aborted) return null
          await delay(1_000 * 2 ** retry, stop).catch(() => {})
          if (stop.aborted) return null
        }
      },
      openSandbox: ({ session }) =>
        this.sandbox({
          runId: session.run.id,
          threadId: session.run.threadId,
          executionToken: session.executionToken,
          projectId: session.run.projectId,
        }),
      onDetachedTeardown: (teardown) => this.track(teardown),
      reportFailure: (error) => this.options.onFailure?.(error),
    })
  }

  /**
   * A run's sandbox: the user's folder for a turn, which the prompt describes, or a blank folder
   * of its own for a child. Its own files go in its thread's directory, outside the folder: the
   * prompt names them, so each run of the thread names the same paths.
   */
  private sandbox(input: {
    readonly runId: string
    readonly threadId: string
    readonly executionToken: string
    readonly projectId: string
    readonly folder?: string
  }): OpenRunSandbox {
    const { apiUrl } = this.options
    const credential = runApiCredential(apiUrl, runTokenFor(input))
    return async ({ signal }) => {
      // Real paths: the OS sandbox compares them, and the agent names files by them.
      await mkdir(this.options.runFilesRoot, { recursive: true })
      const runFiles = join(await realpath(this.options.runFilesRoot), threadDirectory(input))
      const folder = input.folder === undefined ? undefined : await realpath(input.folder)
      let held: (() => Promise<void>) | undefined

      const sandbox: RunSandbox = {
        waitBeforeModel: folder !== undefined,
        contextDirectory: runFiles,
        acquire: async () => {
          const giveBack = await holdRunFiles({ directory: runFiles, runId: input.runId, signal })
          held = giveBack
          try {
            // Each run starts empty, as with a directory of its own: nothing an earlier run, or
            // one that crashed, left there.
            await rm(runFiles, { recursive: true, force: true })
            await mkdir(runFiles, { recursive: true })
            return {
              sandbox: await this.options.openSandbox({
                ...(folder === undefined ? {} : { workingDirectory: folder }),
                runFiles,
                credential,
                signal,
              }),
              ...(folder === undefined
                ? {}
                : { promptContext: { workingDirectory: folder, retention: "computer" as const } }),
            }
          } catch (error) {
            await giveBack()
            throw error
          }
        },
        release: async ({ sandbox }) => {
          try {
            await sandbox.destroy()
            await rm(runFiles, { recursive: true, force: true })
          } finally {
            await held?.()
          }
        },
      }
      return { sandbox }
    }
  }

  private track(teardown: Promise<void>): void {
    this.teardowns.add(teardown)
    void teardown.finally(() => this.teardowns.delete(teardown))
  }
}

/**
 * A thread's files directory, by its id: one thread runs one run at a time, and its children have
 * threads of their own.
 */
function threadDirectory(input: { readonly runId: string; readonly threadId: string }): string {
  if (!/^[A-Za-z0-9_-]+$/.test(input.threadId)) {
    throw new Error(
      `[SixbAgent] Run '${input.runId}' names thread '${input.threadId}', which cannot name a directory.`
    )
  }
  return input.threadId
}

function lease(): string {
  return new Date(Date.now() + LEASE_MS).toISOString()
}

/** What a computer's runs share: the person at it sets the time zone and locale. */
function computerSettings(projectId: string, apiUrl: string): AgentRunSettings {
  const { timeZone, locale } = Intl.DateTimeFormat().resolvedOptions()
  return {
    id: projectId,
    apiBaseUrl: apiUrl,
    subagentConcurrencyPerRun: 4,
    keepsChildWorkspaces: false,
    locale,
    timeZone,
  }
}
