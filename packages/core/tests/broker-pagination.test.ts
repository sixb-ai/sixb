import { expect, test } from "bun:test"
import { InMemoryBroker } from "../src/broker/in-memory"

// Regression proof: restore in-memory.ts before this fix. Each bounded page visits most
// retained records, either to seek its cursor or to allocate the hasMore suffix/prefix.
// Count records accessed instead of imposing a machine-dependent timing threshold.
for (const [direction, cursor] of [
  ["forward", undefined],
  ["forward", "19000"],
  ["backward", undefined],
  ["backward", "1000"],
] as const) {
  test(`bounded ${direction} page at ${cursor ?? "start"}`, async () => {
    const broker = new InMemoryBroker()
    await broker.ensureStream({ projectId: "pagination", stream: { id: "events" } })
    await broker.append({
      projectId: "pagination",
      streamId: "events",
      records: Array.from({ length: 20000 }, (_, index) => ({ payload: { index } })),
    })
    const streams = Reflect.get(broker, "streams") as Map<string, { records: unknown[] }>
    const stream = [...streams.values()][0]!
    let visits = 0
    stream.records = new Proxy(stream.records, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) visits += 1
        return Reflect.get(target, property, receiver)
      },
    })
    const page =
      direction === "forward"
        ? await broker.read({
            projectId: "pagination",
            streamId: "events",
            limit: 10,
            afterCursor: cursor,
          })
        : await broker.tail({
            projectId: "pagination",
            streamId: "events",
            limit: 10,
            beforeCursor: cursor,
          })
    expect(page.records).toHaveLength(10)
    expect(page.hasMore).toBe(true)
    const expectedFirst =
      direction === "forward" ? Number(cursor ?? "0") : Number(cursor ?? "20001") - 11
    expect(page.records.map((record) => record.payload)).toEqual(
      Array.from({ length: 10 }, (_, index) => ({ index: expectedFirst + index }))
    )
    expect(visits).toBeLessThan(100)
  })
}
