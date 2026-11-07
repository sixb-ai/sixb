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
    test("a project has no heartbeat before its first beat", () =>
      withStorage(async (storage) => {
        expect(await storage.list({ projectId })).toEqual([])
      }))

    test("reads back what it stored, dates and failures included", () =>
      withStorage(async (storage) => {
        const heartbeat = {
          projectId,
          owner: "orchestrator" as const,
          beatAt,
          everyMs: 30_000,
          passes: [
            { id: "ontology", lastSucceededAt: succeededAt, consecutiveFailures: 0 },
            { id: "cron", lastSucceededAt: null, consecutiveFailures: 3 },
          ],
        }

        await storage.record(heartbeat)

        expect(await storage.list({ projectId })).toEqual([heartbeat])
      }))

    test("a beat replaces its owner's last one, so a pass no longer run leaves the record", () =>
      withStorage(async (storage) => {
        const owner = "orchestrator" as const
        await storage.record({
          projectId,
          owner,
          beatAt,
          everyMs: 30_000,
          passes: [{ id: "gone", lastSucceededAt: null, consecutiveFailures: 9 }],
        })

        const next = {
          projectId,
          owner,
          beatAt: new Date(beatAt.getTime() + 1_000),
          everyMs: 60_000,
          passes: [],
        }
        await storage.record(next)

        expect(await storage.list({ projectId })).toEqual([next])
      }))

    test("keeps each owner's heartbeat apart", () =>
      withStorage(async (storage) => {
        const beat = { projectId, beatAt, everyMs: 30_000, passes: [] }
        await storage.record({ ...beat, owner: "orchestrator" })
        await storage.record({ ...beat, owner: "embedded" })

        const owners = (await storage.list({ projectId })).map((heartbeat) => heartbeat.owner)
        expect([...owners].sort()).toEqual(["embedded", "orchestrator"])
      }))

    test("keeps each project's heartbeat apart", () =>
      withStorage(async (storage) => {
        await storage.record({
          projectId,
          owner: "orchestrator",
          beatAt,
          everyMs: 30_000,
          passes: [],
        })

        expect(await storage.list({ projectId: `${projectId}-other` })).toEqual([])
      }))
  })
}
