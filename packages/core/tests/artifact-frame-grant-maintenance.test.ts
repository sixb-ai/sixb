import { describe, expect, test } from "bun:test"
import { InMemoryBroker, InMemoryStorage } from "../src"
import { DomainEventService, OntologyOutboxDispatcher } from "../src/events"
import { OntologyMaintenance } from "../src/maintenance"

const projectId = "project"
const now = new Date("2026-10-17T12:00:00.000Z")
const minute = 60 * 1000

describe("expired frame grants", () => {
  // To see this fail, remove the `deleteExpiredFrameGrants` call from
  // `OntologyMaintenance.cleanupExpiredRows`.
  test("a maintenance pass deletes them once they expire", async () => {
    const storage = new InMemoryStorage()
    const events = new DomainEventService({ projectId, broker: new InMemoryBroker() })
    const maintenance = new OntologyMaintenance({
      projectId,
      storage,
      dispatcher: new OntologyOutboxDispatcher({ projectId, storage, events }),
      options: { intervalMs: 60_000 },
      now: () => now,
    })
    const owner = { type: "user", id: "usr_owner" } as const
    await storage.artifacts.create({
      projectId,
      id: "art_deck",
      kind: "slides",
      owner,
      version: {
        title: "Deck",
        entry: "index.html",
        files: [],
        outline: { kind: "slides", slides: [] },
        references: [],
        author: owner,
        createdAt: new Date(now.getTime() - 2 * 60 * minute),
      },
    })
    const tokenHash = (seed: string) => seed.repeat(64)
    const grant = (seed: string, expiresAt: Date) =>
      storage.artifacts.createFrameGrant({
        projectId,
        tokenHash: tokenHash(seed),
        artifactId: "art_deck",
        version: 1,
        targets: [],
        createdAt: new Date(expiresAt.getTime() - 60 * minute),
        expiresAt,
      })
    await grant("a", new Date(now.getTime() - minute))
    await grant("b", new Date(now.getTime() + minute))

    await maintenance.runNow()

    expect(maintenance.getSnapshot().lastError).toBeNull()
    const remaining = await Promise.all(
      ["a", "b"].map((seed) =>
        storage.artifacts.findFrameGrant({ projectId, tokenHash: tokenHash(seed) })
      )
    )
    expect(remaining.map((record) => record?.tokenHash ?? null)).toEqual([null, tokenHash("b")])
  })
})
