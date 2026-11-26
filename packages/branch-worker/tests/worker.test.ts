import { describe, expect, jest, test } from "bun:test"
import { InMemoryStorage, type SixbHostView } from "@sixb/core"
import type { BranchRecord } from "@sixb/core/storage"
import { BRANCH_TICK_MS } from "../src/held-branch"
import { BRANCH_UNOPENED_MS, BranchWorker } from "../src/worker"
import {
  flush,
  hold,
  NAME,
  pass,
  projectId,
  ready,
  row,
  settled,
  setup,
  until,
  useLab,
} from "./helpers/lab"

useLab()

/** The host, but for `overrides`. */
function hostWith(host: SixbHostView, overrides: Partial<SixbHostView>): SixbHostView {
  return Object.assign(Object.create(Object.getPrototypeOf(host)), host, overrides)
}

describe("the branch worker", () => {
  // Guard check: drop the `unopened` branch of `settleStopped` (`worker.ts`).
  test("deletes the copy of a branch unopened for 14 days", async () => {
    const { host, bo, storage } = await setup()
    const held = await hold(host)
    await ready(host)
    await bo.branches.stop(NAME)
    await settled(held.life)
    // Its copy reads production's lake through a slice, which production keeps until it goes.
    await storage.lakeSlices.create({
      id: "slice_expired",
      projectId,
      userId: "usr_bo",
      branch: NAME,
      point: "point",
      versions: [],
      files: [],
      createdAt: new Date(),
      credentialHash: "slice_expired",
      receivedAt: new Date(),
    })
    await storage.hostedBranches.update(
      { projectId, name: NAME, at: new Date() },
      { data: { ...(await row(host)())!.data!, lakeSliceId: "slice_expired" } }
    )

    const stopped = (await row(host)()) as BranchRecord
    jest.advanceTimersByTime(BRANCH_UNOPENED_MS + 60_000)

    const worker = new BranchWorker(host, { apiPublicOrigin: "https://api.shop.test" })
    await worker.start()
    const expired = await until(row(host), (branch) => branch?.data === null)
    await settled(worker.stop())

    expect(expired).toMatchObject({ wanted: "stopped", sandbox: null, owner: null })
    expect(await storage.openBranchNamespace(stopped.namespace)).toBeNull()
    // Guard check: drop `releaseSlices` from `expire` (`held-branch.ts`).
    expect(await storage.lakeSlices.get({ projectId, id: "slice_expired" })).toBeNull()
  })

  // A worker that died holding a branch left its role able to log in, with nothing holding it to
  // its limits. Guard check: drop `closeBranchData` from `settleStopped` (`worker.ts`).
  test("takes away the login of a stopped branch whose worker died holding it", async () => {
    const { host, lab, storage } = await setup()
    const crashed = await storage.hostedBranches.update(
      { projectId, name: NAME, at: new Date() },
      { wanted: "stopped", owner: "branch-worker-gone", leaseExpiresAt: new Date(Date.now() - 1) }
    )

    const worker = new BranchWorker(host, { apiPublicOrigin: "https://api.shop.test" })
    await worker.start()
    await until(row(host), (branch) => branch?.owner === null)
    await settled(worker.stop())

    expect(lab.closed).toEqual([crashed!.namespace])
    expect(await row(host)()).toMatchObject({ state: "stopped", owner: null })
  })

  // Guard check: drop the `branchHostingRequirement` check from `start` (`worker.ts`).
  test("refuses to start on a database user that cannot host branches", async () => {
    const { host, storage } = await setup()
    Object.assign(storage, {
      unmetHostedBranchRequirement: async () => "needs a database user with CREATEDB",
    })
    const worker = new BranchWorker(host, { apiPublicOrigin: "https://api.shop.test" })

    const refused = await worker.start().catch((error: unknown) => error)

    expect(String(refused)).toContain("The branch worker needs a database user with CREATEDB.")
  })

  // A failed branch once read `stopped` a tick later, and nobody learned why it stopped.
  // Guard check: rewrite any lapsed stopped row to `STOPPED` in `settleStopped` (`worker.ts`).
  test("leaves a failed branch failed, with why", async () => {
    const { host, lab } = await setup()
    lab.answering = false
    const held = await hold(host)
    await until(row(host), (branch) => branch?.state === "failed", { stepMs: 60_000 })
    await settled(held.life)

    const worker = new BranchWorker(host, { apiPublicOrigin: "https://api.shop.test" })
    await worker.start()
    await pass(BRANCH_TICK_MS * 3)
    await settled(worker.stop())

    expect(await row(host)()).toMatchObject({
      wanted: "stopped",
      state: "failed",
      error: { message: expect.stringContaining("never answered") },
      owner: null,
    })
  })

  // A delete once swallowed a failed destroy and dropped the row: the sandbox ran on, unknown.
  // Guard check: catch the error of `this.sandbox?.destroy()` in `teardown` (`held-branch.ts`).
  test("keeps a branch whose sandbox it could not destroy, and destroys it on the next claim", async () => {
    const { host, lab, bo } = await setup({ resumable: true })
    const held = await hold(host)
    await ready(host)

    lab.destroyFailure = new Error("sandbox API unavailable")
    await bo.branches.delete(NAME)
    const failed = await until(row(host), (branch) => branch?.error !== null)
    await settled(held.life)
    expect(failed).toMatchObject({ wanted: "deleted", owner: expect.any(String) })
    expect(lab.destroyed).toEqual([])

    const worker = new BranchWorker(host, { apiPublicOrigin: "https://api.shop.test" })
    await worker.start()
    await until(row(host), (branch) => branch === null)
    await settled(worker.stop())
    expect(lab.destroyed).toEqual([failed?.sandbox as string])
  })

  // Vercel refuses to resume a private repository's sandbox without its credentials: the delete
  // once swallowed that, and dropped the row while the sandbox kept the copy and its name.
  // Guard check: resume the saved sandbox to destroy it in `teardown`, or catch the failure of
  // `destroySaved`.
  test("deletes a stopped branch's saved sandbox by name, and keeps the branch until it is gone", async () => {
    const { host, lab, bo } = await setup({ resumable: true })
    const held = await hold(host)
    const opened = await ready(host)
    await bo.branches.stop(NAME)
    await settled(held.life)

    lab.resumeFailures = [new Error("[Sandbox] Authenticated sandbox needs its credentials.")]
    lab.destroyFailure = new Error("sandbox API unavailable")
    await bo.branches.delete(NAME)
    const worker = new BranchWorker(host, { apiPublicOrigin: "https://api.shop.test" })
    await worker.start()
    const kept = await until(row(host), (branch) => branch?.error !== null)
    expect(kept).toMatchObject({ wanted: "deleted", sandbox: opened!.sandbox })

    await until(row(host), (branch) => branch === null)
    await settled(worker.stop())
    expect(lab.destroyed).toEqual([opened!.sandbox!])
    expect(lab.resumed).toEqual([])
  })

  // A delete whose drop failed once read `stopped`: the schema and role stayed, and nobody tried
  // again. Guard check: let a failed teardown fall through to the failure write in `failed`.
  test("tries a failed delete again until the branch is gone", async () => {
    const { host, lab, bo } = await setup()
    lab.dropFailure = new Error("lock timeout")
    await bo.branches.delete(NAME)

    const worker = new BranchWorker(host, { apiPublicOrigin: "https://api.shop.test" })
    await worker.start()
    const failed = await until(row(host), (branch) => branch?.error !== null)
    expect(failed).toMatchObject({ wanted: "deleted", owner: expect.any(String) })

    await until(row(host), (branch) => branch === null)
    await settled(worker.stop())
  })

  // On SIGTERM the worker sat out its whole drain with every sandbox up, past the 10-30 s a
  // platform gives it. Guard check: give `HeldBranch` the run's `signal` alone in `claim`: the
  // drain never ends, and the test times out.
  test("puts its branches back at once when it drains", async () => {
    const { host, lab } = await setup()
    const worker = new BranchWorker(host, { apiPublicOrigin: "https://api.shop.test" })
    await worker.start()
    await ready(host)

    const drained = worker.drain()
    await settled(drained)

    expect(await drained).toBe(true)
    expect(lab.kills).toEqual([1])
    expect(await row(host)()).toMatchObject({ wanted: "running", state: "stopped", owner: null })
  })

  // Guard check: drop the `stopping` case from `failed` (`held-branch.ts`): the branch fails.
  test("puts a branch back, not failed, when it drains during the branch's copy", async () => {
    const { host, lab } = await setup()
    let release: () => void = () => {}
    lab.copyGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const worker = new BranchWorker(host, { apiPublicOrigin: "https://api.shop.test" })
    await worker.start()
    await until(row(host), (branch) => branch?.state === "copying")

    const drained = worker.drain()
    await flush()
    release()
    await settled(drained)

    expect(await drained).toBe(true)
    expect(await row(host)()).toMatchObject({
      wanted: "running",
      state: "stopped",
      error: null,
      owner: null,
    })
  })

  // A delete that kept failing was tried again every 3 s, for good. Guard check: write
  // `owner: null` with the error in `failed` (`held-branch.ts`).
  test("tries a failing delete again minutes later, not at every tick", async () => {
    const { host, lab, bo } = await setup()
    lab.dropsFail = true
    await bo.branches.delete(NAME)

    const worker = new BranchWorker(host, { apiPublicOrigin: "https://api.shop.test" })
    await worker.start()
    await until(row(host), (branch) => branch?.error !== null)
    const first = lab.drops
    await pass(60_000)
    expect(lab.drops).toBe(first)

    await pass(2 * 60_000)
    expect(lab.drops).toBe(first + 1)
    await settled(worker.stop())
  })

  // A worker stopping mid-pass once claimed the branch its own hold had just let go, and made a
  // sandbox for it on its way out. Guard check: drop the stop check from `claim` (`worker.ts`).
  test("claims nothing once it begins stopping", async () => {
    const { lab, host } = await setup()
    const rows = host.storage.hostedBranches!
    const list = rows.list.bind(rows)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    rows.list = async (input) => {
      await gate
      return list(input)
    }

    const worker = new BranchWorker(host, { apiPublicOrigin: "https://api.shop.test" })
    await worker.start()
    await flush()
    const stopping = worker.stop()
    release()
    await settled(stopping)

    expect(lab.created).toEqual([])
    expect((await row(host)())?.owner).toBeNull()
  })

  // A branch the remote never had once got a sandbox whose clone failed with git's own words.
  // Guard check: claim a running branch whatever its `remoteCommit` in `claim`.
  test("starts a branch only once the remote has it", async () => {
    const { lab, host, storage } = await setup()
    await storage.hostedBranches.update(
      { projectId, name: NAME, at: new Date() },
      { remoteCommit: null }
    )
    const rows = host.storage.hostedBranches!
    const update = rows.update.bind(rows)
    // The read of the remote that would set it never comes.
    rows.update = async (input, changes) =>
      "remoteCommit" in changes && changes.remoteCommit !== null ? null : update(input, changes)

    const worker = new BranchWorker(host, { apiPublicOrigin: "https://api.shop.test" })
    await worker.start()
    await pass(BRANCH_TICK_MS * 5)
    await settled(worker.stop())

    expect(lab.created).toEqual([])
  })

  // A recipe's env reaches every sandbox its provider makes: a branch's would hold whatever
  // production gave its agents. Guard check: drop the recipe check from `unmetRequirement`.
  test("refuses a sandbox recipe that sets env, which its provider gives every sandbox", async () => {
    const { host } = await setup({ recipeEnv: { OPENAI_API_KEY: "sk-live" } })

    expect(BranchWorker.unmetRequirement(host, "development")).toContain(
      "recipe without env (it sets OPENAI_API_KEY)"
    )
    expect(() => new BranchWorker(host, { apiPublicOrigin: "https://api.shop.test" })).toThrow(
      "[SixbBranchWorker]"
    )
  })

  // Azure and boxd sandboxes run commands, but serve no port a branch's front listens on.
  // Guard check: drop the `runsBranches` check from `unmetRequirement`.
  test("refuses a sandbox provider that does not say it runs branches, before it clones", async () => {
    const { host } = await setup()
    const commandsOnly = hostWith(host, {
      sandboxes: { ...host.sandboxes!, runsBranches: undefined },
    })

    expect(BranchWorker.unmetRequirement(commandsOnly, "development")).toContain(
      "a sandbox provider that runs branches"
    )
  })

  // smolvm hands source credentials to a forwarder in the guest, which `git clone` never uses: a
  // private repository failed every clone. Guard check: drop the `forwardsRequestCredentials`
  // check from `unmetRequirement`.
  test("refuses a private repository's auth on a provider whose clone gets no credentials", async () => {
    const auth = {
      authorize: async () => ({ requests: [], expiresAt: new Date(), revoke: async () => {} }),
    }
    const { host } = await setup({ auth })
    const forwarding = hostWith(host, {
      sandboxes: { ...host.sandboxes!, forwardsRequestCredentials: true },
    })

    expect(BranchWorker.unmetRequirement(host, "development")).toBeNull()
    expect(BranchWorker.unmetRequirement(forwarding, "development")).toContain(
      "carry the source's credentials themselves"
    )
  })

  // A branch's saved sandbox goes with it, by name. Guard check: drop the `destroy` check from
  // `unmetRequirement`.
  test.each([
    "destroy",
    "stop",
  ] as const)("refuses a provider that resumes sandboxes but cannot %s one by name", async (missing) => {
    const { host } = await setup({ resumable: true })
    const lacking = hostWith(host, {
      sandboxes: { ...host.sandboxes!, [missing]: undefined },
    })

    expect(BranchWorker.unmetRequirement(host, "development")).toBeNull()
    expect(BranchWorker.unmetRequirement(lacking, "development")).toContain(
      "stops and deletes a saved sandbox by name"
    )
  })

  // Guard check: drop the `sharesHost` check from `unmetRequirement`.
  test("refuses in production a sandbox that runs branches on this host", async () => {
    const { host } = await setup()
    const local = hostWith(host, { sandboxes: { ...host.sandboxes!, sharesHost: true } })

    expect(BranchWorker.unmetRequirement(local, "production")).toContain(
      "@sixb/sandboxes-vercel or @sixb/sandboxes-smolvm"
    )
    expect(BranchWorker.unmetRequirement(local, "development")).toBeNull()
  })

  test("needs production's PostgreSQL, the repository and a sandbox factory", async () => {
    const { host } = await setup()

    expect(BranchWorker.unmetRequirement(host, "production")).toBeNull()
    expect(
      BranchWorker.unmetRequirement(
        hostWith(host, { storage: new InMemoryStorage() }),
        "production"
      )
    ).toContain("@sixb/pg")
    expect(BranchWorker.unmetRequirement(hostWith(host, { source: null }), "production")).toContain(
      "repository"
    )
    expect(
      BranchWorker.unmetRequirement(hostWith(host, { sandboxes: undefined }), "production")
    ).toContain("sandbox factory")
  })
})
