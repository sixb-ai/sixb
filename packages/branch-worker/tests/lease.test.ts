import { describe, expect, jest, spyOn, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRANCH_LEASE_MS, BRANCH_TICK_MS } from "../src/held-branch"
import * as stagingModule from "../src/staging"
import { BranchWorker } from "../src/worker"
import {
  atGate,
  flush,
  hold,
  NAME,
  onCleanup,
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

describe("the lease on a branch", () => {
  // A clone and a copy took longer than the lease, which only the tick renewed: a second worker
  // took the branch mid-open, and both copied into the same schema.
  // Guard check: remove the heartbeat from `life` (`held-branch.ts`).
  test("never lapses while its owner opens the branch, however long that takes", async () => {
    const { lab, host } = await setup()
    let release: () => void = () => {}
    lab.createGate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = new BranchWorker(host, { apiPublicOrigin: "https://api.shop.test" })
    const second = new BranchWorker(host, { apiPublicOrigin: "https://api.shop.test" })
    await first.start()
    await until(
      async () => (await row(host)())?.owner,
      (owner) => owner !== null
    )
    const owner = (await row(host)())?.owner
    await second.start()

    await pass(5 * 60_000, 200)
    expect((await row(host)())?.owner).toBe(owner)

    release()
    await ready(host)
    await settled(second.stop())
    await settled(first.stop())
    expect(lab.created).toHaveLength(1)
  })

  // Guard check: let `claim` skip a branch whose lease lapsed with an owner (`worker.ts`).
  test("lapses once its owner is gone, and another worker takes the branch over", async () => {
    const { lab, host, storage } = await setup()
    // The first owner's process died: its lease stays on the row, renewed by nobody.
    await storage.hostedBranches.update(
      { projectId, name: NAME, at: new Date() },
      {
        owner: "branch-worker-gone",
        leaseExpiresAt: new Date(Date.now() + BRANCH_LEASE_MS),
        state: "copying",
      }
    )

    const worker = new BranchWorker(host, { apiPublicOrigin: "https://api.shop.test" })
    await worker.start()
    await pass(BRANCH_LEASE_MS / 2)
    expect((await row(host)())?.owner).toBe("branch-worker-gone")

    await pass(BRANCH_LEASE_MS)
    const taken = await ready(host)
    await settled(worker.stop())

    expect(taken?.owner).not.toBe("branch-worker-gone")
    expect(lab.created).toHaveLength(1)
    expect(taken?.data?.objects).toBe(1)
  })

  // A worker cut off from its storage kept the branch's runtime up after its lease ran out, while
  // another worker could take the branch. Guard check: drop the lease check after the heartbeat's
  // attempts in `renewLease`.
  test("lets the branch go once it cannot renew its lease in time", async () => {
    const { lab, host } = await setup()
    const held = await hold(host)
    await ready(host)

    const rows = host.storage.hostedBranches!
    rows.update = async () => {
      throw new Error("storage unreachable")
    }
    await pass(BRANCH_LEASE_MS + BRANCH_TICK_MS * 3)
    await settled(held.life)

    expect(lab.kills).toEqual([1])
    expect(lab.destroyed).toEqual(["sandbox-1"])
  })

  // A worker paused past its lease came back to a branch another worker had taken: it stops its
  // own session, which its handle is pinned to, and touches nothing of the branch's. A session it
  // left running kept Vercel from resuming the name. Guard check: return before the sandbox's stop
  // in `release` when the hold is lost, or release a lost branch as any other in `failed`.
  test("stops only its own session when it comes back to a branch another worker took", async () => {
    const { lab, host } = await setup({ resumable: true })
    const held = await hold(host)
    await ready(host)

    // Asleep past its lease, while another worker takes the branch and resumes its sandbox.
    jest.setSystemTime(Date.now() + BRANCH_LEASE_MS * 2)
    await host.storage.hostedBranches!.update(
      { projectId, name: NAME, at: new Date() },
      { owner: "worker-b", leaseExpiresAt: new Date(Date.now() + BRANCH_LEASE_MS) }
    )
    await pass(BRANCH_TICK_MS * 2)
    await settled(held.life)

    expect(lab.kills).toEqual([1])
    expect(lab.stopped).toEqual(["sandbox-1"])
    expect(lab.destroyed).toEqual([])
    expect(lab.closed).toEqual([])
    expect(await row(host)()).toMatchObject({ owner: "worker-b" })
  })

  // A worker asleep mid-copy woke to its copy's next step before its heartbeat, and dropped the
  // schema the branch's new owner was running on. Guard check: drop the `fence` before
  // `prepareBranchData` in `copyIntoSandbox` (`copy.ts`).
  test("drops nothing of a branch another worker took while it was paused mid-copy", async () => {
    const { lab, host, bo, storage } = await setup()
    const held = await hold(host)
    await ready(host)
    const prepared = lab.prepared

    jest.advanceTimersByTime(1_000)
    await bo.branches.refresh(NAME)

    // Asleep right after the copy began, on its way to the schema.
    let wake: () => void = () => {}
    const asleep = new Promise<void>((resolve) => {
      wake = resolve
    })
    const staging = spyOn(stagingModule, "stagingDirectory")
    staging.mockImplementation(async () => {
      await atGate(asleep)
      return mkdtemp(join(tmpdir(), "sixb-branch-staging-test-"))
    })
    onCleanup(() => staging.mockRestore())
    await until(
      async () => staging.mock.calls.length,
      (calls) => calls === 1
    )

    // Past its lease, while another worker takes the branch over.
    jest.setSystemTime(Date.now() + BRANCH_LEASE_MS * 2)
    await storage.hostedBranches.update(
      { projectId, name: NAME, at: new Date() },
      { owner: "worker-b", leaseExpiresAt: new Date(Date.now() + BRANCH_LEASE_MS) }
    )
    wake()
    await settled(held.life)

    expect(lab.prepared).toBe(prepared)
    expect(await row(host)()).toMatchObject({ owner: "worker-b" })
  })

  // A load runs the branch's code as its role for up to an hour: the limits once waited for the
  // next tick, after it. Guard check: remove the enforcement interval from `life`.
  test("holds the role to its limits while the branch loads its copy", async () => {
    const { lab, host } = await setup()
    let release: () => void = () => {}
    lab.importGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const held = await hold(host)
    await until(
      async () => lab.loading,
      (loading) => loading
    )

    const before = lab.enforced
    await pass(BRANCH_TICK_MS * 4)
    await flush()
    expect(lab.enforced - before).toBeGreaterThanOrEqual(3)

    release()
    await ready(host)
    await held.stop()
  })
})
