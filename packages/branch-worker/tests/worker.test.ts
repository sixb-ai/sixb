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
    expect(failed).toMatchObject({ wanted: "deleted", owner: null })
    expect(lab.destroyed).toEqual([])

    const worker = new BranchWorker(host, { apiPublicOrigin: "https://api.shop.test" })
    await worker.start()
    await until(row(host), (branch) => branch === null)
    await settled(worker.stop())
    expect(lab.destroyed).toEqual([failed?.sandbox as string])
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
    expect(failed).toMatchObject({ wanted: "deleted", owner: null })

    await until(row(host), (branch) => branch === null)
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
