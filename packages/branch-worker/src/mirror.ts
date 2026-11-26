import { tmpdir } from "node:os"
import type { SandboxRequestCredential, SixbHostView } from "@sixb/core"
import { sourceGitUrl } from "@sixb/core/internal/branches"
import type { SandboxSourceCredentials } from "@sixb/core/sandboxes"
import type { BranchChanges, BranchRecord, BranchStorage } from "@sixb/core/storage"
import { authorizeSourceRead } from "./source-auth"

/** How long one `git ls-remote` may take before the check gives up until the next one. */
const GIT_TIMEOUT_MS = 2 * 60_000
/** A source credential is replaced this long before it expires. */
const CREDENTIALS_MARGIN_MS = 5 * 60_000

/**
 * What the project's remote holds, read for every branch at once, so no sandbox polls its own
 * remote. A new commit reaches the row's `remoteCommit`, and the worker holding the branch pulls
 * it. A branch whose remote branch is gone ends, running or stopped; one the remote never had
 * fails, and says so. A merge ends nothing by itself: the branch ends when its remote branch is
 * deleted, as a merged one usually is, or its copy goes after 14 days unopened.
 *
 * Only `git ls-remote`: nothing is fetched on production's host.
 */
export class BranchMirror {
  private credentials: SandboxSourceCredentials | undefined
  /** Who the current credential reads as. */
  private readsAs: string | undefined

  constructor(
    private readonly host: SixbHostView,
    private readonly branches: BranchStorage
  ) {}

  /**
   * Reads the remote's heads, and writes each branch's verdict to its row. A read that fails says
   * why on the branches that wait for it, so the Console shows more than a branch waiting.
   */
  async check(signal: AbortSignal): Promise<void> {
    const rows = await this.branches.list({ projectId: this.host.id })
    if (rows.length === 0) return

    let heads: ReadonlyMap<string, string>
    try {
      heads = await this.remoteHeads(signal, readerOf(rows))
    } catch (error) {
      if (!signal.aborted) await this.tellWaiting(rows, this.remoteError(error))
      throw error
    }

    for (const row of rows) {
      if (row.wanted === "deleted") continue
      const found = verdict(row, heads.get(row.name) ?? null, this.url())
      const changes = row.remoteError === null ? found : { ...found, remoteError: null }
      if (!changes) continue

      // A row its worker moved on meanwhile is checked again next time.
      await this.branches.update(
        { projectId: this.host.id, name: row.name, revision: row.revision, at: new Date() },
        changes
      )
    }
  }

  /** Writes why the remote could not be read on the branches that wait for its first read. */
  private async tellWaiting(rows: readonly BranchRecord[], message: string): Promise<void> {
    for (const row of rows) {
      const waiting = row.wanted === "running" && row.remoteCommit === null
      if (!waiting || row.remoteError === message) continue

      // A row its worker moved on meanwhile is told at the next read.
      await this.branches.update(
        { projectId: this.host.id, name: row.name, revision: row.revision, at: new Date() },
        { remoteError: message }
      )
    }
  }

  /** Why the read failed, in git's or the source auth's words, and what a private one needs. */
  private remoteError(error: unknown): string {
    const reason = (error instanceof Error ? error.message : String(error))
      .replace(/^\[\w+\] /, "")
      .replace(/\.$/, "")
    const hint = this.host.sandboxDefinition?.auth
      ? ""
      : " A private repository needs the sandbox factory's `auth`, such as `githubApp(...)`."
    return `Production could not read the branches of ${this.url()}: ${reason}.${hint}`
  }

  /** Lets the source credential go. */
  async close(): Promise<void> {
    await this.credentials?.revoke().catch(() => {})
    this.credentials = undefined
  }

  private async remoteHeads(
    signal: AbortSignal,
    reader: string
  ): Promise<ReadonlyMap<string, string>> {
    const env = gitCredentialEnv((await this.authorize(signal, reader))?.requests ?? [])
    const result = await git(["ls-remote", "--heads", "--", this.url()], { env, signal })

    const heads = new Map<string, string>()
    for (const line of result.split("\n")) {
      const head = /^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/.exec(line)
      if (head?.[1] && head[2]) heads.set(head[2], head[1])
    }
    return heads
  }

  /**
   * Read access from the project's source authentication, as `reader`, kept until it nears its
   * expiry. An OAuth source reading as each person (`githubOAuth`) has no project-wide reader, so
   * the remote is read as a branch's creator, who reads it to clone their branch anyway.
   */
  private async authorize(
    signal: AbortSignal,
    reader: string
  ): Promise<SandboxSourceCredentials | null> {
    const current = this.credentials
    const fresh = current && current.expiresAt.getTime() - Date.now() > CREDENTIALS_MARGIN_MS
    if (fresh && this.readsAs === reader) return current

    this.credentials =
      (await authorizeSourceRead(this.host, {
        signal,
        requestedBy: { type: "user", id: reader },
      })) ?? undefined
    this.readsAs = reader
    await current?.revoke().catch(() => {})
    return this.credentials ?? null
  }

  private url(): string {
    if (!this.host.source) throw new Error("[SixbBranchWorker] The project names no repository.")
    return sourceGitUrl(this.host.source)
  }
}

/** Whose read the remote is read with: a waiting branch's creator first, as it waits on it. */
function readerOf(rows: readonly BranchRecord[]): string {
  const waiting = rows.find((row) => row.wanted === "running" && row.remoteCommit === null)
  return (waiting ?? (rows[0] as BranchRecord)).createdBy
}

/** What the remote's head says of one branch: a new commit, its end, or nothing. */
function verdict(row: BranchRecord, head: string | null, url: string): BranchChanges | null {
  if (head === null) {
    // Gone from the remote: so is the branch, and everything it has.
    if (row.remoteCommit !== null) return { wanted: "deleted" }
    if (row.wanted !== "running") return null
    return {
      wanted: "stopped",
      state: "failed",
      error: {
        message: `There is no branch '${row.name}' on ${url}: push it, then open it again.`,
      },
    }
  }
  return row.remoteCommit === head ? null : { remoteCommit: head }
}

/**
 * Each credential as git's `http.<origin>/.extraHeader`, through its environment: never in its
 * arguments, which other users of the host can read.
 */
export function gitCredentialEnv(
  credentials: readonly SandboxRequestCredential[]
): Record<string, string> {
  const env: Record<string, string> = {}
  credentials.forEach((credential, index) => {
    env[`GIT_CONFIG_KEY_${index}`] = `http.${credential.origin}/.extraHeader`
    env[`GIT_CONFIG_VALUE_${index}`] = `Authorization: ${credential.headers.Authorization}`
  })
  if (credentials.length > 0) env.GIT_CONFIG_COUNT = String(credentials.length)
  return env
}

/** One git command, with a bound, its output. */
async function git(
  args: readonly string[],
  options: { readonly env: Record<string, string>; readonly signal: AbortSignal }
): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: tmpdir(),
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const kill = () => child.kill("SIGKILL")
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, GIT_TIMEOUT_MS)
  options.signal.addEventListener("abort", kill, { once: true })

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (timedOut) {
      throw new Error(
        `[SixbBranchWorker] git ${args[0]} took longer than ${GIT_TIMEOUT_MS / 1_000} s.`
      )
    }
    if (exitCode !== 0) {
      throw new Error(`[SixbBranchWorker] git ${args[0]} failed: ${stderr.trim()}`)
    }
    return stdout
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener("abort", kill)
  }
}
