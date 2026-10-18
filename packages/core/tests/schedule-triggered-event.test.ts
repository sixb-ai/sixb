import { expect, test } from "bun:test"
import { InMemoryBroker } from "../src"
import { DomainEventService } from "../src/events"

test("schedule.triggered events land on the schedules topic, partitioned by schedule id", async () => {
  const events = new DomainEventService({ projectId: "test-project", broker: new InMemoryBroker() })
  const payload = {
    scheduleId: "nightly-sync",
    occurrenceAt: "2026-01-15T00:00:00.000Z",
    triggeredAt: "2026-01-15T00:00:00.100Z",
    occurrenceKey: "nightly-sync:2026-01-15T00:00:00.000Z",
  }

  const [stored] = await events.append({ events: [{ type: "schedule.triggered", payload }] })

  expect(stored).toMatchObject({
    type: "schedule.triggered",
    topic: "schedules",
    partitionKey: "nightly-sync",
    payload,
  })
  expect(await events.read({ topics: ["schedules"] })).toEqual([stored!])
})
