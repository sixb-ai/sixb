import { describe, expect, test } from "bun:test"
import type { BranchRecord, BranchStorage } from "../storage/branches"

export interface BranchStorageContractSuiteOptions<TStorage extends BranchStorage = BranchStorage> {
  /** Returns an isolated provider capability for every test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "branch-contract"
const createdAt = new Date("2026-11-17T12:00:00.000Z")
const later = new Date("2026-11-17T12:05:00.000Z")

function newBranch(name: string): Omit<BranchRecord, "updatedAt" | "revision"> {
  return {
    projectId,
    name,
    wanted: "running",
    state: "stopped",
    key: "k".repeat(48),
    port: 43_100,
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
    createdBy: "user-1",
    createdAt,
    lastSeenAt: createdAt,
  }
}

/** Provider-neutral persistence contract for branches. */
export function runBranchStorageContractSuite<TStorage extends BranchStorage>(
  label: string,
  options: BranchStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (run: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await run(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(`${label} branch contract`, () => {
    test("creates a branch at revision 1, and reads it back with every field", () =>
      withStorage(async (storage) => {
        const { branch, created } = await storage.create(newBranch("vendor-invoices"))
        expect(created).toBe(true)
        expect(branch).toEqual({
          ...newBranch("vendor-invoices"),
          updatedAt: createdAt,
          revision: 1,
        })
        expect(await storage.get({ projectId, name: "vendor-invoices" })).toEqual(branch)
        expect(await storage.get({ projectId: "other", name: "vendor-invoices" })).toBeNull()
      }))

    test("a name already taken returns that branch, unchanged", () =>
      withStorage(async (storage) => {
        const first = await storage.create(newBranch("fix"))
        const second = await storage.create({ ...newBranch("fix"), key: "other".repeat(10) })
        expect(second).toEqual({ branch: first.branch, created: false })
      }))

    test("lists a project's branches by name", () =>
      withStorage(async (storage) => {
        await storage.create(newBranch("b/two"))
        await storage.create(newBranch("a-one"))
        await storage.create({ ...newBranch("elsewhere"), projectId: "other" })
        expect((await storage.list({ projectId })).map((branch) => branch.name)).toEqual([
          "a-one",
          "b/two",
        ])
      }))

    test("writes only over the revision it read, and every write moves the revision on", () =>
      withStorage(async (storage) => {
        await storage.create(newBranch("fix"))
        const ready = await storage.update(
          { projectId, name: "fix", revision: 1, at: later },
          {
            state: "ready",
            url: "https://fix.example.com",
            generation: 3,
            commit: "b7e2d10",
            manifest: "9e1c",
            error: { message: "Vendr is not defined", file: "ontology/vendor.ts" },
            pushedAt: later,
            owner: "worker-1",
            leaseExpiresAt: later,
          }
        )
        expect(ready).toMatchObject({
          state: "ready",
          generation: 3,
          error: { message: "Vendr is not defined", file: "ontology/vendor.ts" },
          pushedAt: later,
          leaseExpiresAt: later,
          updatedAt: later,
          revision: 2,
        })
        expect(await storage.get({ projectId, name: "fix" })).toEqual(ready)

        // A writer that read revision 1 lost the race: nothing it wanted is written.
        expect(
          await storage.update(
            { projectId, name: "fix", revision: 1, at: later },
            { owner: "worker-2" }
          )
        ).toBeNull()
        expect((await storage.get({ projectId, name: "fix" }))?.owner).toBe("worker-1")

        const touched = await storage.update(
          { projectId, name: "fix", at: later },
          { lastSeenAt: later, error: null }
        )
        expect(touched).toMatchObject({
          revision: 3,
          lastSeenAt: later,
          error: null,
          owner: "worker-1",
        })
      }))

    test("updating or deleting a branch that isn't there does nothing", () =>
      withStorage(async (storage) => {
        expect(
          await storage.update({ projectId, name: "gone", at: later }, { wanted: "stopped" })
        ).toBeNull()
        expect(await storage.delete({ projectId, name: "gone" })).toBe(false)

        await storage.create(newBranch("fix"))
        expect(await storage.delete({ projectId, name: "fix" })).toBe(true)
        expect(await storage.get({ projectId, name: "fix" })).toBeNull()
      }))
  })
}
