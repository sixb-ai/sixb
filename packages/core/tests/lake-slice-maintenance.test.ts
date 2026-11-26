import { describe, expect, test } from "bun:test"
import { InMemoryBroker, InMemoryStorage } from "../src"
import { DomainEventService, OntologyOutboxDispatcher } from "../src/events"
import { OntologyMaintenance } from "../src/maintenance/ontology-maintenance"

const projectId = "project"
const now = new Date("2026-11-24T12:00:00.000Z")
const minute = 60 * 1000

describe("expired lake slices", () => {
  // To see this fail, remove the `lakeSlices.deleteExpired` call from
  // `OntologyMaintenance.cleanupExpiredRows`, or delete slices as soon as their token expires.
  test("a maintenance pass deletes them once a branch could no longer be opened", async () => {
    const storage = new InMemoryStorage()
    const events = new DomainEventService({ projectId, broker: new InMemoryBroker() })
    const errors: unknown[] = []
    const maintenance = new OntologyMaintenance({
      projectId,
      storage,
      dispatcher: new OntologyOutboxDispatcher({ projectId, storage, events }),
      options: { intervalMs: 60_000 },
      now: () => now,
      onError: (error) => errors.push(error),
    })
    const slice = async (id: string, expiresAt: Date) => {
      await storage.lakeSlices.create({
        id,
        projectId,
        userId: "usr_alice",
        branch: "invoice-reminders",
        point: "ducklake:4",
        versions: [{ datasetId: "erp.invoices", versionId: "ducklake:4" }],
        files: ["main/t/a.parquet"],
        createdAt: new Date(expiresAt.getTime() - 15 * minute),
      })
      await storage.lakeSlices.createGrant({
        id: `${id}_grant`,
        projectId,
        tokenHash: id.repeat(64),
        sliceId: id,
        createdAt: new Date(expiresAt.getTime() - 15 * minute),
        expiresAt,
      })
    }
    await slice("a", new Date(now.getTime() - 15 * 24 * 60 * minute))
    await slice("b", new Date(now.getTime() - minute))

    await maintenance.runNow()

    expect(errors).toEqual([])
    const remaining = await Promise.all(
      ["a", "b"].map((id) => storage.lakeSlices.get({ projectId, id }))
    )
    expect(remaining.map((record) => record?.id ?? null)).toEqual([null, "b"])
  })
})
