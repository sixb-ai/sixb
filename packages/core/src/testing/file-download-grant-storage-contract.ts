import { describe, expect, test } from "bun:test"
import type {
  FileDownloadGrantRecord,
  FileDownloadGrantStorage,
} from "../storage/file-download-grants"

export interface FileDownloadGrantStorageContractSuiteOptions<
  TStorage extends FileDownloadGrantStorage = FileDownloadGrantStorage,
> {
  /** Returns an isolated provider capability for every test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "file-download-grant-contract"
const createdAt = new Date("2026-10-05T12:00:00.000Z")
const hour = 60 * 60 * 1000

/** Provider-neutral persistence contract for file download grants. */
export function runFileDownloadGrantStorageContractSuite<TStorage extends FileDownloadGrantStorage>(
  label: string,
  options: FileDownloadGrantStorageContractSuiteOptions<TStorage>
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
    test("finds a grant by its project and token hash", async () => {
      await withStorage(async (storage) => {
        const grant = grantRecord()
        await storage.create(grant)

        expect(await storage.findByTokenHash({ projectId, tokenHash: grant.tokenHash })).toEqual(
          grant
        )
        expect(
          await storage.findByTokenHash({ projectId: "other-project", tokenHash: grant.tokenHash })
        ).toBeNull()
        expect(await storage.findByTokenHash({ projectId, tokenHash: "f".repeat(64) })).toBeNull()
      })
    })

    test("rejects a second grant with the same id or token hash", async () => {
      await withStorage(async (storage) => {
        await storage.create(grantRecord())

        await expect(storage.create(grantRecord({ tokenHash: "b".repeat(64) }))).rejects.toThrow()
        await expect(storage.create(grantRecord({ id: "filedownload_2" }))).rejects.toThrow()
        await storage.create(grantRecord({ projectId: "other-project" }))
      })
    })

    test("keeps the first revocation", async () => {
      await withStorage(async (storage) => {
        await storage.create(grantRecord())
        const first = new Date(createdAt.getTime() + 1_000)

        const revoked = await storage.revoke({ projectId, id: "filedownload_1", revokedAt: first })
        const again = await storage.revoke({
          projectId,
          id: "filedownload_1",
          revokedAt: new Date(first.getTime() + 1_000),
        })

        expect(revoked?.revokedAt).toEqual(first)
        expect(again?.revokedAt).toEqual(first)
        expect(
          (await storage.findByTokenHash({ projectId, tokenHash: "a".repeat(64) }))?.revokedAt
        ).toEqual(first)
        expect(
          await storage.revoke({
            projectId: "other-project",
            id: "filedownload_1",
            revokedAt: first,
          })
        ).toBeNull()
      })
    })

    test("deletes only the project's grants that expired before the cutoff, up to the limit", async () => {
      await withStorage(async (storage) => {
        const expiringAt = (hours: number) => new Date(createdAt.getTime() + hours * hour)
        await storage.create(
          grantRecord({ id: "g1", tokenHash: "1".repeat(64), expiresAt: expiringAt(1) })
        )
        await storage.create(
          grantRecord({ id: "g2", tokenHash: "2".repeat(64), expiresAt: expiringAt(2) })
        )
        await storage.create(
          grantRecord({ id: "g3", tokenHash: "3".repeat(64), expiresAt: expiringAt(3) })
        )
        await storage.create(
          grantRecord({ projectId: "other-project", id: "g1", expiresAt: expiringAt(1) })
        )
        const cutoff = { projectId, expiredBefore: expiringAt(3) }

        expect(await storage.deleteExpired({ ...cutoff, limit: 1 })).toBe(1)
        expect(await storage.deleteExpired({ ...cutoff, limit: 10 })).toBe(1)
        expect(await storage.deleteExpired({ ...cutoff, limit: 10 })).toBe(0)

        const remaining = await Promise.all(
          ["1", "2", "3"].map((digit) =>
            storage.findByTokenHash({ projectId, tokenHash: digit.repeat(64) })
          )
        )
        expect(remaining.map((grant) => grant?.id ?? null)).toEqual([null, null, "g3"])
        expect(
          await storage.findByTokenHash({ projectId: "other-project", tokenHash: "a".repeat(64) })
        ).not.toBeNull()
      })
    })
  })
}

function grantRecord(overrides: Partial<FileDownloadGrantRecord> = {}): FileDownloadGrantRecord {
  const digest = "c".repeat(64)
  return {
    id: "filedownload_1",
    projectId,
    tokenHash: "a".repeat(64),
    file: {
      blobId: `blob_${digest}`,
      digest: `sha256:${digest}`,
      sizeBytes: 10,
      fileName: "photo.jpg",
      mediaType: "image/jpeg",
    },
    executionId: "execution-1",
    createdAt,
    expiresAt: new Date(createdAt.getTime() + hour),
    ...overrides,
  }
}
