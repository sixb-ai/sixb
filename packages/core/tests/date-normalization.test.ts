import { describe, expect, test } from "bun:test"
import { defineObjectType, prop } from "../src"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// Regression: the typed surface accepts `Date | string` for date/timestamp
// props, so passing a `Date` typechecks. The upsert path must serialize it to an
// ISO string before the value reaches the event store (which only stores JSON);
// otherwise `events.append` rejects the Date.

const Task = defineObjectType({
  id: "task",
  name: "Task",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("createdAt", "timestamp"),
    prop("due", "date"),
  ],
})

describe("date/timestamp normalization on upsert", () => {
  test("serializes Date props to ISO strings through upsert and upsertBatch", async () => {
    const deps = createTestRuntimeDeps()
    const sixb = createTestSixb({ ontology: [Task], ...deps })
    const stored = async (primaryId: string) =>
      (
        await deps.storage.objects.getByPrimaryId({
          projectId: sixb.execution.projectId,
          objectTypeId: "task",
          primaryId,
        })
      )?.properties

    const at = new Date("2026-06-20T12:34:56.000Z")
    const row = await sixb.objects(Task).upsert({
      properties: { id: "t1", createdAt: at, due: at },
    })
    expect(row.properties).toMatchObject({
      createdAt: "2026-06-20T12:34:56.000Z",
      due: "2026-06-20",
    })
    expect(await stored("t1")).toMatchObject({
      createdAt: "2026-06-20T12:34:56.000Z",
      due: "2026-06-20",
    })

    const iso = await sixb.objects(Task).upsert({
      properties: { id: "t2", createdAt: "2026-01-02T03:04:05.000Z" },
    })
    expect(iso.properties.createdAt).toBe("2026-01-02T03:04:05.000Z")

    const results = await sixb.objects.upsertBatch("task", [
      { properties: { id: "b1", createdAt: at } },
      { properties: { id: "b2", createdAt: at } },
    ])
    expect(results.map((result) => result.ok && result.value.properties.createdAt)).toEqual([
      "2026-06-20T12:34:56.000Z",
      "2026-06-20T12:34:56.000Z",
    ])
    expect((await stored("b2"))?.createdAt).toBe("2026-06-20T12:34:56.000Z")
  })
})
