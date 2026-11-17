import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BranchRecord } from "@sixb/core/storage"
import { InMemoryStorage } from "@sixb/core/storage"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { BranchRuntimes } from "../src/branches"

/**
 * A branch's whole life on the local provider, against a git origin on disk: claimed, checked
 * out, served, pulled after a push, and stopped once nobody wants it. The project's `sixb` is a
 * stand-in that reports the checkout as the real front would.
 */

const PROJECT = "branch-runtimes"
const KEY = "k".repeat(64)

/** Answers the front's status route, with the key, from what the checkout holds. */
const FAKE_SIXB = `#!/usr/bin/env bun
const port = Number(process.argv[process.argv.indexOf("--port") + 1])
const branch = process.argv[process.argv.indexOf("--branch") + 1]
const commits = new Map()
Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    if (request.headers.get("x-sixb-branch-key") !== process.env.SIXB_BRANCH_KEY) {
      return new Response("Unauthorized", { status: 401 })
    }
    const commit = (await Bun.$\`git rev-parse HEAD\`.text()).trim()
    if (!commits.has(commit)) commits.set(commit, commits.size + 1)
    const manifest = (await Bun.file("version.txt").text()).trim()
    return Response.json({ branch, generation: commits.get(commit), state: "ready", commit, manifest, error: null })
  },
})
`

async function run(cwd: string, ...command: string[]): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 20_000)
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  clearTimeout(timer)
  if (code !== 0) {
    throw new Error(`${command.join(" ")} failed: ${await new Response(child.stderr).text()}`)
  }
  return output.trim()
}

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const { port } = listener
  listener.stop(true)
  return port
}

async function waitFor(
  read: () => Promise<BranchRecord | null>,
  until: (branch: BranchRecord) => boolean,
  timeoutMs = 30_000
): Promise<BranchRecord> {
  const deadline = Date.now() + timeoutMs
  let last: BranchRecord | null = null
  while (Date.now() < deadline) {
    last = await read()
    if (last && until(last)) return last
    await Bun.sleep(100)
  }
  throw new Error(`The branch never got there; last seen: ${JSON.stringify(last)}`)
}

describe("branch runtimes on the local provider", () => {
  const roots: string[] = []
  const stops: (() => Promise<unknown>)[] = []
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  test("serves a branch, follows its pushes, and stops it when it's no longer wanted", async () => {
    const root = await mkdtemp(join(tmpdir(), "sixb-branch-runtimes-"))
    roots.push(root)
    const origin = join(root, "origin")
    await mkdir(join(origin, "node_modules", ".bin"), { recursive: true })
    await run(root, "git", "init", "-q", "-b", "main", origin)
    await writeFile(join(origin, "node_modules", ".bin", "sixb"), FAKE_SIXB)
    await chmod(join(origin, "node_modules", ".bin", "sixb"), 0o755)
    await writeFile(join(origin, "version.txt"), "one\n")
    const commit = (message: string) =>
      run(
        origin,
        "git",
        "-c",
        "user.email=e@example.com",
        "-c",
        "user.name=E",
        "commit",
        "-qam",
        message
      )
    await run(origin, "git", "add", "-A")
    await commit("first")
    await run(origin, "git", "checkout", "-qb", "vendor-invoices")
    // A checked-out branch can't take a push, and the runtime must fetch what moved.
    await run(origin, "git", "checkout", "-q", "main")

    // The recipe clones from GitHub: this machine's git reads the origin on disk instead.
    const gitconfig = join(root, "gitconfig")
    await writeFile(
      gitconfig,
      `[url "${origin}"]\n\tinsteadOf = https://github.com/acme/operations.git\n`
    )
    const storage = new InMemoryStorage()
    const branches = storage.branches
    const runtimes = new BranchRuntimes({
      id: PROJECT,
      source: { repository: "acme/operations" },
      sandboxes: new LocalSandboxFactory({
        isolation: "none",
        env: { GIT_CONFIG_GLOBAL: gitconfig, HOME: root },
      }),
      branches,
    })
    const read = () => branches.get({ projectId: PROJECT, name: "vendor-invoices" })
    const now = new Date()
    await branches.create({
      projectId: PROJECT,
      name: "vendor-invoices",
      wanted: "running",
      state: "stopped",
      key: KEY,
      port: freePort(),
      sandbox: null,
      url: null,
      generation: null,
      commit: null,
      manifest: null,
      error: null,
      pushedAt: null,
      pulledAt: null,
      owner: null,
      leaseExpiresAt: null,
      createdBy: null,
      createdAt: now,
      lastSeenAt: now,
    })

    const abort = new AbortController()
    const running = runtimes.run(abort.signal)
    stops.push(async () => {
      abort.abort()
      await running
    })

    const first = await waitFor(read, (branch) => branch.state === "ready")
    const url = String(first.url)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(first).toMatchObject({
      generation: 1,
      manifest: "one",
      commit: await run(origin, "git", "rev-parse", "vendor-invoices"),
    })
    expect(first.owner).toStartWith("branch-owner-")
    // The runtime answers only the project, which holds its key.
    expect((await fetch(`${url}/__sixb/branch`)).status).toBe(401)

    // A push the webhook reported is taken at the owner's next look.
    await run(origin, "git", "checkout", "-q", "vendor-invoices")
    await writeFile(join(origin, "version.txt"), "two\n")
    await commit("second")
    await run(origin, "git", "checkout", "-q", "main")
    await branches.update(
      { projectId: PROJECT, name: "vendor-invoices", at: new Date() },
      { pushedAt: new Date() }
    )
    const pulled = await waitFor(read, (branch) => branch.manifest === "two")
    expect(pulled).toMatchObject({ state: "ready", generation: 2 })
    expect(pulled.pulledAt?.getTime()).toBe(pulled.pushedAt?.getTime())

    // No webhook told it this time: the runtime fetches its remote on its own.
    await run(origin, "git", "checkout", "-q", "vendor-invoices")
    await writeFile(join(origin, "version.txt"), "three\n")
    await commit("third")
    await run(origin, "git", "checkout", "-q", "main")
    expect(await waitFor(read, (branch) => branch.manifest === "three")).toMatchObject({
      state: "ready",
      generation: 3,
    })

    await branches.update(
      { projectId: PROJECT, name: "vendor-invoices", at: new Date() },
      { wanted: "stopped" }
    )
    const stopped = await waitFor(read, (branch) => branch.state === "stopped")
    expect(stopped).toMatchObject({ url: null, owner: null, leaseExpiresAt: null, manifest: null })
    expect(
      await fetch(`${url}/__sixb/branch`).then(
        () => "answered",
        () => "closed"
      )
    ).toBe("closed")
  }, 90_000)
})
