import { describe, expect, test } from "bun:test"
import type {
  LakeSliceGrantRecord,
  LakeSliceRecord,
  LakeSliceStorage,
} from "../storage/lake-slices"

export interface LakeSliceStorageContractSuiteOptions<
  TStorage extends LakeSliceStorage = LakeSliceStorage,
> {
  /** Returns an isolated provider capability for every test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "lake-slice-contract"
const createdAt = new Date("2026-11-24T12:00:00.000Z")
const minute = 60_000

/** Provider-neutral persistence contract for branches' slices and their tokens. */
export function runLakeSliceStorageContractSuite<TStorage extends LakeSliceStorage>(
  label: string,
  options: LakeSliceStorageContractSuiteOptions<TStorage>
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
    test("keeps a slice with its exact files, and the latest expiry of its tokens", async () => {
      await withStorage(async (storage) => {
        await storage.create(slice())
        await storage.createGrant(grant({ expiresAt: at(30) }))
        await storage.createGrant(grant({ id: "g2", tokenHash: "b".repeat(64), expiresAt: at(15) }))

        expect(await storage.get({ projectId, id: "slice_1" })).toEqual({
          ...slice(),
          lastTokenExpiresAt: at(30),
        })
        expect(
          await storage.findGrantByTokenHash({ projectId, tokenHash: "a".repeat(64) })
        ).toEqual(grant({ expiresAt: at(30) }))
        expect(
          await storage.findGrantByTokenHash({ projectId: "other", tokenHash: "a".repeat(64) })
        ).toBeNull()
        expect(await storage.get({ projectId: "other", id: "slice_1" })).toBeNull()
      })
    })

    test("finds a slice by its branch credential, in its project only", async () => {
      await withStorage(async (storage) => {
        await storage.create({ ...slice(), credentialHash: "c".repeat(64) })
        await storage.create({ ...slice(), id: "slice_2" })

        expect(
          await storage.findByCredentialHash({ projectId, credentialHash: "c".repeat(64) })
        ).toEqual({ ...slice(), credentialHash: "c".repeat(64) })
        expect(
          await storage.findByCredentialHash({ projectId: "other", credentialHash: "c".repeat(64) })
        ).toBeNull()
        expect(
          await storage.findByCredentialHash({ projectId, credentialHash: "d".repeat(64) })
        ).toBeNull()
        expect(await storage.get({ projectId, id: "slice_2" })).toEqual({
          ...slice(),
          id: "slice_2",
        })
      })
    })

    test("refuses a second slice or grant with the same id, and a grant of no slice", async () => {
      await withStorage(async (storage) => {
        await storage.create(slice())
        await storage.createGrant(grant())

        const errors = await Promise.all([
          storage.create(slice()).catch((error) => error),
          storage.createGrant(grant({ tokenHash: "c".repeat(64) })).catch((error) => error),
          storage.createGrant(grant({ id: "g3" })).catch((error) => error),
          storage
            .createGrant(grant({ id: "g4", tokenHash: "d".repeat(64), sliceId: "missing" }))
            .catch((error) => error),
        ])
        for (const error of errors) expect(error).toBeInstanceOf(Error)
      })
    })

    test("lists slices live after a time, from their last token or their creation", async () => {
      await withStorage(async (storage) => {
        await storage.create(slice({ id: "untokened" }))
        await storage.create(slice({ id: "tokened", createdAt: at(1) }))
        await storage.createGrant(grant({ sliceId: "tokened", expiresAt: at(60) }))

        const ids = async (minutes: number) =>
          (await storage.listLive({ projectId, liveAfter: at(minutes) })).map((live) => live.id)

        expect(await ids(-1)).toEqual(["untokened", "tokened"])
        expect(await ids(30)).toEqual(["tokened"])
        expect(await ids(60)).toEqual([])
      })
    })

    test("deletes slices no longer live, with their grants, up to the limit", async () => {
      await withStorage(async (storage) => {
        for (const id of ["s1", "s2", "s3"]) await storage.create(slice({ id }))
        await storage.createGrant(grant({ sliceId: "s3", expiresAt: at(90) }))
        await storage.create(slice({ id: "s1", projectId: "other" }))

        expect(await storage.deleteExpired({ projectId, before: at(60), limit: 1 })).toBe(1)
        expect(await storage.deleteExpired({ projectId, before: at(60), limit: 10 })).toBe(1)
        expect((await storage.listLive({ projectId, liveAfter: at(-1) })).map((s) => s.id)).toEqual(
          ["s3"]
        )
        expect(await storage.get({ projectId: "other", id: "s1" })).not.toBeNull()

        await storage.delete({ projectId, id: "s3" })
        expect(
          await storage.findGrantByTokenHash({ projectId, tokenHash: "a".repeat(64) })
        ).toBeNull()
      })
    })
  })
}

function at(minutes: number): Date {
  return new Date(createdAt.getTime() + minutes * minute)
}

function slice(overrides: Partial<LakeSliceRecord> = {}): LakeSliceRecord {
  return {
    id: "slice_1",
    projectId,
    userId: "usr_alice",
    branch: "invoice-reminders",
    point: "ducklake:42",
    versions: [{ datasetId: "erp.invoices", versionId: "ducklake:42" }],
    files: ["main/sixb__ds__erp__invoices/a.parquet", "sixb-branch-copies/x-1-42.parquet"],
    createdAt,
    ...overrides,
  }
}

function grant(overrides: Partial<LakeSliceGrantRecord> = {}): LakeSliceGrantRecord {
  return {
    id: "g1",
    projectId,
    tokenHash: "a".repeat(64),
    sliceId: "slice_1",
    createdAt,
    expiresAt: at(15),
    ...overrides,
  }
}
