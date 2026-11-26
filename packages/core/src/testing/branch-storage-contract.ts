import { describe, expect, test } from "bun:test"
import type { BranchRecord, BranchStorage } from "../storage/branches"

export interface BranchStorageContractSuiteOptions<TStorage extends BranchStorage = BranchStorage> {
  /** Returns an isolated provider capability for every test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "branch-contract"
const createdAt = new Date("2026-11-24T12:00:00.000Z")

/** Provider-neutral persistence contract for the rows of hosted branches. */
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

  describe(label, () => {
    test("adds a branch once, at revision 1", async () => {
      await withStorage(async (storage) => {
        const first = await storage.create(branch("feature/invoices"))
        const again = await storage.create({ ...branch("feature/invoices"), port: 20_000 })

        expect(first).toEqual({
          created: true,
          branch: { ...branch("feature/invoices"), updatedAt: createdAt, revision: 1 },
        })
        expect(again).toEqual({ created: false, branch: first.branch })
      })
    })

    test("keeps every field as written, by project and in name order", async () => {
      await withStorage(async (storage) => {
        const full: Omit<BranchRecord, "updatedAt" | "revision"> = {
          ...branch("feature/b"),
          wanted: "deleted",
          state: "failed",
          sandbox: "sixb-branch-b",
          url: "http://127.0.0.1:4000",
          generation: 3,
          commit: "a".repeat(40),
          error: { message: "The project failed to start.", file: "ontology/invoice.ts" },
          data: {
            takenAt: new Date("2026-11-24T12:01:00.000Z"),
            objects: 50_000,
            skipped: [{ objectTypeId: "Payroll", reason: "not readable" }],
            lakeSliceId: "lakeslice_1",
          },
          refreshRequestedAt: new Date("2026-11-24T12:02:00.000Z"),
          port: 20_000,
          remoteCommit: "b".repeat(40),
          remoteError: "git ls-remote failed: could not read Username",
          // Guard check: drop a code from `NOTICES` in `storage/branches/record.ts`: its notice
          // is then lost on the way back.
          notices: [
            { code: "data-reset", message: "Its machine was lost." },
            { code: "database-limit", message: "Its data grew past its limit." },
            { code: "database-closed", message: "It held up production's database." },
          ],
          owner: "branch-worker-1",
          leaseExpiresAt: new Date("2026-11-24T12:05:00.000Z"),
        }
        await storage.create(full)
        await storage.create(branch("feature/a"))
        await storage.create({ ...branch("feature/a"), projectId: "other" })

        expect(await storage.get({ projectId, name: "feature/b" })).toEqual({
          ...full,
          updatedAt: createdAt,
          revision: 1,
        })
        expect((await storage.list({ projectId })).map((row) => row.name)).toEqual([
          "feature/a",
          "feature/b",
        ])
        expect(await storage.get({ projectId, name: "missing" })).toBeNull()
      })
    })

    test("writes over the revision it read, and refuses a stale one", async () => {
      await withStorage(async (storage) => {
        await storage.create(branch("feature/invoices"))
        const at = new Date("2026-11-24T12:10:00.000Z")
        const ref = { projectId, name: "feature/invoices" }

        const claimed = await storage.update(
          { ...ref, revision: 1, at },
          { owner: "worker-a", leaseExpiresAt: at }
        )
        const stale = await storage.update({ ...ref, revision: 1, at }, { owner: "worker-b" })
        const forced = await storage.update({ ...ref, at }, { lastSeenAt: at })

        expect(claimed).toMatchObject({ owner: "worker-a", revision: 2, updatedAt: at })
        expect(stale).toBeNull()
        expect(forced).toMatchObject({ owner: "worker-a", lastSeenAt: at, revision: 3 })
        expect(await storage.update({ projectId, name: "missing", at }, {})).toBeNull()
      })
    })

    test("removes a row", async () => {
      await withStorage(async (storage) => {
        await storage.create(branch("feature/invoices"))

        expect(await storage.delete({ projectId, name: "feature/invoices" })).toBe(true)
        expect(await storage.delete({ projectId, name: "feature/invoices" })).toBe(false)
        expect(await storage.get({ projectId, name: "feature/invoices" })).toBeNull()
      })
    })
  })
}

function branch(name: string): Omit<BranchRecord, "updatedAt" | "revision"> {
  return {
    projectId,
    name,
    namespace: name.replace(/[^a-z0-9]+/g, "-"),
    wanted: "running",
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
    createdAt,
    openedAt: createdAt,
    lastSeenAt: createdAt,
  }
}
