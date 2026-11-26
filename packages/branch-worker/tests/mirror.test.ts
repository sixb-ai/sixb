import { afterEach, describe, expect, test } from "bun:test"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import type { SandboxSourceAuthInput } from "@sixb/core/sandboxes"
import type { BranchRecord } from "@sixb/core/storage"
import { BranchMirror, gitCredentialEnv } from "../src/mirror"
import { gitRepository } from "./helpers/git"

// The worker's read of the remote, as it reads it every 10 seconds: a real git remote on disk,
// and branch rows in memory.

const projectId = "branch-mirror"
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(
  options: {
    readonly authorized?: (input: SandboxSourceAuthInput) => void
    /** The repository production names, when not the one on disk. */
    readonly source?: string
  } = {}
) {
  const repository = await gitRepository()
  cleanups.push(() => repository.remove())

  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    source: { repository: options.source ?? repository.path },
    ...(options.authorized
      ? {
          sandboxes: {
            supportsRequestCredentials: true,
            configuration: {
              auth: {
                authorize: async (input: SandboxSourceAuthInput) => {
                  options.authorized?.(input)
                  return {
                    requests: [],
                    expiresAt: new Date(Date.now() + 60 * 60_000),
                    revoke: async () => {},
                  }
                },
              },
            },
            create: async () => {
              throw new Error("No sandbox here.")
            },
          },
        }
      : {}),
    storage,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
  const branches = storage.hostedBranches
  const mirror = new BranchMirror(host, branches)
  cleanups.push(() => mirror.close())
  const check = () => mirror.check(new AbortController().signal)
  const row = (name: string) => branches.get({ projectId, name })
  const open = (name: string, wanted: BranchRecord["wanted"] = "running") =>
    branches.create(record(name, wanted))

  return { repository, check, row, open, branches }
}

describe("the read of the remote", () => {
  // Guard check: return null from `verdict` whatever the remote holds.
  test("tells a branch the commit its remote head is at", async () => {
    const { repository, check, row, open } = await setup()
    await repository.branch("feature/a")
    await open("feature/a")

    await check()
    expect((await row("feature/a"))?.remoteCommit).toBe(await repository.head("feature/a"))

    const pushed = await repository.commit("feature/a", "a.ts")
    await check()
    expect((await row("feature/a"))?.remoteCommit).toBe(pushed)
  })

  // Guard check: skip a row with no head on the remote in `verdict`.
  test("wants a branch deleted once its remote branch is, running or stopped", async () => {
    const { repository, check, row, open } = await setup()
    await repository.branch("feature/a")
    await repository.branch("feature/b")
    await open("feature/a")
    await open("feature/b", "stopped")
    await check()

    await repository.deleteBranch("feature/a")
    await repository.deleteBranch("feature/b")
    await check()

    expect((await row("feature/a"))?.wanted).toBe("deleted")
    expect((await row("feature/b"))?.wanted).toBe("deleted")
  })

  // A branch opened before its first push was once deleted at once, with nothing said.
  // Guard check: want any branch without a head deleted in `verdict`.
  test("fails a branch the remote never had, and says so", async () => {
    const { check, row, open } = await setup()
    await open("feature/typo")

    await check()

    expect(await row("feature/typo")).toMatchObject({
      wanted: "stopped",
      state: "failed",
      error: { message: expect.stringContaining("There is no branch 'feature/typo'") },
    })
  })

  // A reset of a branch to main once read as a merge, and deleted its data.
  test("ends nothing because a branch's head is in the default branch", async () => {
    const { repository, check, row, open } = await setup()
    await repository.branch("feature/merged")
    await open("feature/merged")
    await repository.commit("feature/merged", "merged.ts")
    await check()

    await repository.merge("feature/merged")
    await check()

    expect((await row("feature/merged"))?.wanted).toBe("running")
  })

  // A private repository read without credentials once left its branches waiting, and the
  // Console blamed a missing worker. Guard check: drop `tellWaiting` from `check` (`mirror.ts`).
  test("says why it could not read the remote on the branches that wait for it", async () => {
    const { check, row, open } = await setup({ source: "/no/such/repository.git" })
    await open("feature/a")
    await open("feature/b", "stopped")

    const failure = await check().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((await row("feature/a"))?.remoteError).toMatch(
      /^Production could not read the branches of \/no\/such\/repository\.git: git ls-remote failed: .+\. A private repository needs the sandbox factory's `auth`, such as `githubApp\(\.\.\.\)`\.$/s
    )
    expect((await row("feature/b"))?.remoteError).toBeNull()
  })

  // Guard check: leave `remoteError` alone in `check` once a read succeeds.
  test("clears what it said once it reads the remote", async () => {
    const { repository, check, row, open, branches } = await setup()
    await repository.branch("feature/a")
    await open("feature/a")
    await branches.update(
      { projectId, name: "feature/a", at: new Date() },
      { remoteError: "Production could not read the branches." }
    )

    await check()

    expect(await row("feature/a")).toMatchObject({
      remoteError: null,
      remoteCommit: expect.any(String),
    })
  })

  // An OAuth source reads with the connection it names, as an agent's workspace does: without the
  // resolver, `githubOAuth` failed every read. Guard check: drop `connectionToken` from
  // `authorizeSourceRead` (`source-auth.ts`).
  test("hands an OAuth source the project's connections, with nobody to read as", async () => {
    const inputs: SandboxSourceAuthInput[] = []
    const { repository, check, open } = await setup({ authorized: (input) => inputs.push(input) })
    await repository.branch("feature/a")
    await open("feature/a")

    await check()

    expect(inputs).toHaveLength(1)
    expect(typeof inputs[0]?.connectionToken).toBe("function")
    expect(inputs[0]?.requestedBy).toBeUndefined()
  })

  // Guard check: authorize on every check in `authorize`.
  test("keeps its source credential until it nears its expiry", async () => {
    let authorized = 0
    const { repository, check, open } = await setup({ authorized: () => (authorized += 1) })
    await repository.branch("feature/a")
    await open("feature/a")

    await check()
    await check()

    expect(authorized).toBe(1)
  })
})

test("hands each source credential to git for its origin, through its environment", () => {
  expect(
    gitCredentialEnv([
      {
        origin: "https://github.com",
        path: { prefix: "/acme/shop" },
        method: ["GET", "POST"],
        headers: { Authorization: "Basic dG9rZW4=" },
      },
    ])
  ).toEqual({
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
    GIT_CONFIG_VALUE_0: "Authorization: Basic dG9rZW4=",
  })
})

function record(
  name: string,
  wanted: BranchRecord["wanted"]
): Omit<BranchRecord, "updatedAt" | "revision"> {
  const at = new Date("2026-11-24T12:00:00.000Z")
  return {
    projectId,
    name,
    namespace: name.replace(/[^a-z0-9]+/g, "-"),
    wanted,
    state: "stopped",
    createdBy: "usr_ada",
    key: "k".repeat(43),
    port: null,
    sandbox: null,
    url: null,
    generation: null,
    commit: null,
    error: null,
    data: null,
    refreshRequestedAt: null,
    remoteCommit: null,
    remoteError: null,
    notices: [],
    owner: null,
    leaseExpiresAt: null,
    createdAt: at,
    openedAt: at,
    lastSeenAt: at,
  }
}
