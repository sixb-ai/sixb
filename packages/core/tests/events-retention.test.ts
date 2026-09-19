import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type BrokerRetention,
  createSixb,
  defineObjectType,
  InMemoryBroker,
  prop,
  SixbHost,
} from "../src"
import { BrokerCursorExpiredError, BrokerError } from "../src/broker"
import { DEFAULT_EVENTS_RETENTION_MS, EVENTS_STREAM } from "../src/events"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const hosts: SixbHost<readonly []>[] = []
const nowSpy = () => spyOn(Date, "now")
let clock: ReturnType<typeof nowSpy> | undefined
afterEach(async () => {
  clock?.mockRestore()
  await Promise.all(hosts.splice(0).map((host) => host.closeBroker()))
})
function host(retention?: BrokerRetention) {
  const result = new SixbHost({
    ontology: [] as const,
    ...createTestRuntimeDeps(),
    broker: new InMemoryBroker({
      streamRetention: retention ? { __events: retention } : undefined,
    }),
  })
  hosts.push(result)
  return result
}
function event(id: string) {
  return {
    type: "schedule.triggered" as const,
    payload: {
      scheduleId: id,
      occurrenceAt: "2026-09-19T00:00:00.000Z",
      triggeredAt: "2026-09-19T00:00:00.000Z",
      occurrenceKey: id,
    },
  }
}

// Removal proof: pass params.stream directly in InMemoryBroker.ensureStream(), bypassing
// resolveStream(). Count/byte overrides and expired-cursor checks then fail.
test("configured count cap preserves explicit expired-cursor errors for readers and subscribers", async () => {
  const runtime = host({ maxRecords: 2 })
  const rows = await runtime.events.append({
    events: [event("1"), event("2"), event("3"), event("4")],
  })
  expect((await runtime.events.read()).map((e) => e.id)).toEqual(rows.slice(-2).map((e) => e.id))
  await expect(runtime.events.read({ afterCursor: rows[0]!.cursor })).rejects.toBeInstanceOf(
    BrokerCursorExpiredError
  )
  await expect(
    runtime.events.subscribe({ afterCursor: rows[0]!.cursor }, () => {})
  ).rejects.toBeInstanceOf(BrokerCursorExpiredError)
  expect(await runtime.events.read({ afterCursor: rows[1]!.cursor })).toHaveLength(2)
})

test("byte cap is enforced even when the event count is small", async () => {
  const runtime = host({ maxBytes: 1 })
  const rows = await runtime.events.append({ events: [event("1"), event("2")] })
  expect(await runtime.events.read()).toEqual([])
  await expect(runtime.events.read({ afterCursor: rows[0]!.cursor })).rejects.toBeInstanceOf(
    BrokerCursorExpiredError
  )
})

test("default age stays two days when only the count cap is set", async () => {
  let now = Date.now()
  clock = nowSpy().mockImplementation(() => now)
  const runtime = host({ maxAgeMs: undefined, maxRecords: 10 })
  await runtime.events.append({ events: [event("1")] })
  now += DEFAULT_EVENTS_RETENTION_MS - 1
  expect(await runtime.events.read()).toHaveLength(1)
  now += 2
  expect(await runtime.events.read()).toEqual([])
})

test("custom age is applied and configuration is copied at construction", async () => {
  let now = Date.now()
  clock = nowSpy().mockImplementation(() => now)
  const retention = { maxAgeMs: 100, maxRecords: 2 }
  const runtime = host(retention)
  retention.maxRecords = 100
  await runtime.events.append({ events: [event("1"), event("2"), event("3")] })
  expect(await runtime.events.read()).toHaveLength(2)
  now += 101
  expect(await runtime.events.read()).toEqual([])
  expect(EVENTS_STREAM.retention).toEqual({ maxAgeMs: DEFAULT_EVENTS_RETENTION_MS })
})

test("broker retention rejects invalid limits before use", () => {
  for (const field of ["maxAgeMs", "maxRecords", "maxBytes"] as const)
    for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(
        () => new InMemoryBroker({ streamRetention: { __events: { [field]: value } } })
      ).toThrow(BrokerError)
  expect(() => new InMemoryBroker({ streamRetention: { " ": { maxRecords: 1 } } })).toThrow(
    BrokerError
  )
})

test("broker overrides are scoped by stream and preserve omitted stream limits", async () => {
  const broker = new InMemoryBroker({ streamRetention: { __events: { maxRecords: 2 } } })
  for (const projectId of ["first", "second"]) {
    for (const id of ["__events", "__logs"]) {
      await broker.ensureStream({ projectId, stream: { id, retention: { maxRecords: 5 } } })
      await broker.append({
        projectId,
        streamId: id,
        records: [1, 2, 3, 4].map((payload) => ({ payload })),
      })
      expect((await broker.read({ projectId, streamId: id })).records).toHaveLength(
        id === "__events" ? 2 : 4
      )
    }
  }
  // Supplying an age override must not remove the stream's original count cap.
  const ageOnly = new InMemoryBroker({ streamRetention: { custom: { maxAgeMs: 60_000 } } })
  await ageOnly.ensureStream({
    projectId: "test",
    stream: { id: "custom", retention: { maxRecords: 1 } },
  })
  await ageOnly.append({
    projectId: "test",
    streamId: "custom",
    records: [{ payload: 1 }, { payload: 2 }],
  })
  expect(
    (await ageOnly.read({ projectId: "test", streamId: "custom" })).records.map((r) => r.payload)
  ).toEqual([2])
})

test("createSixb uses broker retention without host configuration", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sixb-retention-"))
  const Room = defineObjectType({
    id: "Room",
    name: "Room",
    properties: [prop("id", "string", { primary: true, required: true })],
  })
  const runtime = await createSixb({
    projectRoot,
    ontologies: [Room],
    ...createTestRuntimeDeps(),
    broker: new InMemoryBroker({ streamRetention: { __events: { maxRecords: 1 } } }),
  })
  try {
    await runtime.events.append({ events: [event("1"), event("2")] })
    expect(await runtime.events.read()).toHaveLength(1)
  } finally {
    await runtime.closeBroker()
    await rm(projectRoot, { recursive: true, force: true })
  }
})
