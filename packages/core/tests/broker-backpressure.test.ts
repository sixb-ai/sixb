import { expect, test } from "bun:test"
import { getEventListeners } from "node:events"
import { InMemoryBroker } from "../src/broker"
import { waitForSubscriber } from "../src/broker/subscriber"
import { DomainEventService } from "../src/events/service"

test("completed deliveries do not retain abort listeners", async () => {
  const controller = new AbortController()
  for (let i = 0; i < 1000; i++) await waitForSubscriber(Promise.resolve(), controller.signal)
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  await expect(
    waitForSubscriber(Promise.reject(new Error("rejected")), controller.signal)
  ).rejects.toThrow("rejected")
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
})

// Revert InMemoryBroker's cursor pump / the event wrapper's returned promise to reproduce failures.
test("retained replay is bounded and publishers do not wait for subscribers", async () => {
  const broker = new InMemoryBroker()
  await broker.ensureStream({ projectId: "test", stream: { id: "test" } })
  await broker.append({
    projectId: "test",
    streamId: "test",
    records: Array.from({ length: 1000 }, (_, payload) => ({ payload })),
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let received = 0
  const unsubscribe = await broker.subscribe(
    { projectId: "test", streamId: "test", from: "earliest" },
    async (records) => {
      received += records.length
      await gate
    }
  )
  try {
    await broker.append({ projectId: "test", streamId: "test", records: [{ payload: "live" }] })
    expect(received).toBeGreaterThan(0)
    expect(received).toBeLessThanOrEqual(100)
    release()
    for (let i = 0; i < 100 && received !== 1001; i++) await Bun.sleep(1)
    expect(received).toBe(1001)
  } finally {
    release()
    unsubscribe()
  }
})

test("domain event handlers apply backpressure through the event wrapper", async () => {
  const service = new DomainEventService({ projectId: "test", broker: new InMemoryBroker() })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const unsubscribe = await service.subscribe({}, async () => {
    calls += 1
    await gate
  })
  const append = () =>
    service.append({
      events: [
        {
          type: "schedule.triggered",
          payload: {
            scheduleId: "test",
            occurrenceAt: "2026-09-17T00:00:00Z",
            triggeredAt: "2026-09-17T00:00:00Z",
            occurrenceKey: "test",
          },
        },
      ],
    })
  try {
    await append()
    await append()
    expect(calls).toBe(1)
    release()
    for (let i = 0; i < 100 && calls !== 2; i++) await Bun.sleep(1)
    expect(calls).toBe(2)
  } finally {
    release()
    unsubscribe()
  }
})
