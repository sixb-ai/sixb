import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { orderedChangesSince } from "../lib/sources/client-utils"
import { AtomicJsonStore } from "../lib/sources/file-store"

const roots = new Set<string>()
const documentSchema = z.object({ schemaVersion: z.literal(1), values: z.array(z.number()) })
type Document = z.infer<typeof documentSchema>

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

describe("AtomicJsonStore", () => {
  test("validates persisted documents and serializes mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "northline-source-"))
    roots.add(root)
    const store = new AtomicJsonStore<Document>(join(root, "state.json"), documentSchema)
    await store.write({ schemaVersion: 1, values: [] })

    await Promise.all(
      [1, 2, 3, 4].map((value) =>
        store.update(async (document) => {
          await Bun.sleep(2)
          document.values.push(value)
        })
      )
    )

    expect((await store.read()).values.sort()).toEqual([1, 2, 3, 4])
  })

  test("reports invalid JSON as a source-boundary error", async () => {
    const root = await mkdtemp(join(tmpdir(), "northline-source-"))
    roots.add(root)
    const path = join(root, "state.json")
    await Bun.write(path, "not json")
    const store = new AtomicJsonStore<Document>(path, documentSchema)

    await expect(store.read()).rejects.toThrow("[NorthlineSource] Cannot read")
  })
})

describe("orderedChangesSince", () => {
  const changes = [
    { kind: "upsert" as const, row: { id: "quote-1", status: "sent" } },
    { kind: "delete" as const, key: { id: "quote-2" } },
  ]

  test("returns ordered changes after the checkpoint with the next cursors", () => {
    expect(orderedChangesSince(changes, "1")).toEqual([
      { kind: "delete", key: { id: "quote-2" }, cursor: "2" },
    ])
    expect(orderedChangesSince(changes, "2")).toEqual([])
  })

  test("defensively clones changes and reports a source-log gap", () => {
    const [first] = orderedChangesSince(changes)
    expect(first?.cursor).toBe("1")
    if (first?.kind === "upsert") first.row.status = "changed"
    const original = changes[0]
    if (original?.kind !== "upsert") throw new Error("Expected the first change to be an upsert")
    expect(original.row.status).toBe("sent")

    expect(() => orderedChangesSince(changes, "3")).toThrow("beyond the retained change history")
  })
})
