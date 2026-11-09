import { describe, expect, test } from "bun:test"
import type { LakeRetentionRunStorage } from "../storage/lake-retention-runs"

export interface LakeRetentionRunStorageContractSuiteOptions<
  TStorage extends LakeRetentionRunStorage = LakeRetentionRunStorage,
> {
  /** Returns an isolated provider capability for every test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "lake-retention-run-contract"
const startedAt = new Date("2026-11-07T11:59:00.000Z")
const finishedAt = new Date("2026-11-07T12:00:00.000Z")

/** Provider-neutral persistence contract for the last automatic lake retention run. */
export function runLakeRetentionRunStorageContractSuite<TStorage extends LakeRetentionRunStorage>(
  label: string,
  options: LakeRetentionRunStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (run: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await run(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(`${label} lake retention run contract`, () => {
    test("no project has a run before its first one", () =>
      withStorage(async (storage) => {
        expect(await storage.getLast({ projectId })).toBeNull()
      }))

    test("reads back a finished run", () =>
      withStorage(async (storage) => {
        const run = { projectId, startedAt, finishedAt, failed: true }

        await storage.record(run)

        expect(await storage.getLast({ projectId })).toEqual(run)
      }))

    test("reads back a run that has not finished", () =>
      withStorage(async (storage) => {
        const run = { projectId, startedAt, finishedAt: null, failed: false }

        await storage.record(run)

        expect(await storage.getLast({ projectId })).toEqual(run)
      }))

    test("a later run replaces the last one", () =>
      withStorage(async (storage) => {
        const later = { projectId, startedAt: finishedAt, finishedAt: null, failed: false }

        await storage.record({ projectId, startedAt, finishedAt, failed: true })
        await storage.record(later)

        expect(await storage.getLast({ projectId })).toEqual(later)
      }))

    test("projects keep their own run", () =>
      withStorage(async (storage) => {
        const other = { projectId: `${projectId}-other`, startedAt, finishedAt, failed: true }

        await storage.record({ projectId, startedAt, finishedAt, failed: false })
        await storage.record(other)

        expect(await storage.getLast({ projectId: other.projectId })).toEqual(other)
        expect(await storage.getLast({ projectId })).toMatchObject({ failed: false })
      }))
  })
}
