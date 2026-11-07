import { describe, expect, test } from "bun:test"
import type { MaintenanceHeartbeatStorage } from "../storage/maintenance-heartbeats"

export interface MaintenanceHeartbeatStorageContractSuiteOptions<
  TStorage extends MaintenanceHeartbeatStorage = MaintenanceHeartbeatStorage,
> {
  /** Returns an isolated provider capability for every test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "maintenance-heartbeat-contract"
const beatAt = new Date("2026-11-07T12:00:00.000Z")
const succeededAt = new Date("2026-11-07T11:59:30.000Z")

/** Provider-neutral persistence contract for the maintenance heartbeat. */
export function runMaintenanceHeartbeatStorageContractSuite<
  TStorage extends MaintenanceHeartbeatStorage,
>(label: string, options: MaintenanceHeartbeatStorageContractSuiteOptions<TStorage>): void {
  const withStorage = async (run: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await run(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(`${label} maintenance heartbeat contract`, () => {
    test("no project has a heartbeat before its first beat", () =>
      withStorage(async (storage) => {
        expect(await storage.get({ projectId })).toBeNull()
      }))

    test("reads back what it stored, dates and failures included", () =>
      withStorage(async (storage) => {
        const heartbeat = {
          projectId,
          beatAt,
          everyMs: 30_000,
          passes: [
            {
              id: "ontology",
              lastSucceededAt: succeededAt,
              consecutiveFailures: 0,
              lastError: null,
            },
            {
              id: "cron",
              lastSucceededAt: null,
              consecutiveFailures: 3,
              lastError: "Error: broker refused",
            },
          ],
        }

        await storage.record(heartbeat)

        expect(await storage.get({ projectId })).toEqual(heartbeat)
      }))

    test("a beat replaces the last one, so a pass no longer run leaves the record", () =>
      withStorage(async (storage) => {
        await storage.record({
          projectId,
          beatAt,
          everyMs: 30_000,
          passes: [
            { id: "gone", lastSucceededAt: null, consecutiveFailures: 9, lastError: "Error: old" },
          ],
        })

        const next = { projectId, beatAt: new Date(beatAt.getTime() + 1_000), everyMs: 60_000 }
        await storage.record({ ...next, passes: [] })

        expect(await storage.get({ projectId })).toEqual({ ...next, passes: [] })
      }))

    test("keeps one heartbeat per project", () =>
      withStorage(async (storage) => {
        await storage.record({ projectId, beatAt, everyMs: 30_000, passes: [] })

        expect(await storage.get({ projectId: `${projectId}-other` })).toBeNull()
      }))
  })
}
