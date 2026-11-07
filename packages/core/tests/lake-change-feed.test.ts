import { describe, expect, test } from "bun:test"
import type { DatasetLatestVersionSummary, LatestVersionsSince } from "@sixb/core/lake-storage"
import { LakeChangeFeed } from "../src/lake-change-feed"

const FRESH_FOR_MS = 30_000

function summary(datasetId: string, versionId: string): DatasetLatestVersionSummary {
  return { datasetId, versionId, mode: "snapshot", createdAt: new Date(0) }
}

/** A feed whose lake answers from a script, and which counts what it is asked. */
function createScene() {
  let nowMs = 0
  const reads: { cursor: string | null; datasetIds: readonly string[] | undefined }[] = []
  const scene = {
    pending: [] as DatasetLatestVersionSummary[],
    answer: null as null | (() => Promise<LatestVersionsSince | null>),
    reads,
    advance(ms: number) {
      nowMs += ms
    },
  }
  const feed = new LakeChangeFeed({
    projectId: "project",
    freshForMs: FRESH_FOR_MS,
    now: () => nowMs,
    lakeStorage: {
      async listLatestVersionsSince(input) {
        reads.push({ cursor: input.cursor, datasetIds: input.datasetIds })
        if (scene.answer) return scene.answer()

        const versions = scene.pending
        scene.pending = []
        return { cursor: String(reads.length), versions }
      },
    },
  })
  return { ...scene, scene, feed }
}

function reader(feed: LakeChangeFeed, datasetIds: string[], onCursorLost = () => {}) {
  return feed.subscribe({ datasetIds, onCursorLost })
}

describe("LakeChangeFeed", () => {
  // Reproduce: return false from `isFresh`; each reader runs its own query.
  test("two readers within one interval cost one query", async () => {
    const { feed, reads, scene } = createScene()
    const projections = reader(feed, ["orders"])
    const triggers = reader(feed, ["orders", "customers"])

    await projections.read()
    scene.advance(FRESH_FOR_MS - 1)
    await triggers.read()

    expect(reads).toHaveLength(1)
    expect([...(reads[0]?.datasetIds ?? [])].sort()).toEqual(["customers", "orders"])
  })

  test("readers that ask at once share the query in flight", async () => {
    const { feed, reads } = createScene()
    const first = reader(feed, ["orders"])
    const second = reader(feed, ["orders"])

    await Promise.all([first.read(), second.read()])

    expect(reads).toHaveLength(1)
  })

  // Reproduce: clear `unread` for every subscriber in `readFor`; the later reader misses the commit.
  test("a commit reaches every reader once, whichever asked first", async () => {
    const { feed, scene } = createScene()
    const first = reader(feed, ["orders"])
    const second = reader(feed, ["orders"])
    await first.read()
    await second.read()

    scene.pending = [summary("orders", "v2")]
    scene.advance(FRESH_FOR_MS)

    expect(await first.read()).toEqual([summary("orders", "v2")])
    expect(await first.read()).toEqual([])
    expect(await second.read()).toEqual([summary("orders", "v2")])
    expect(await second.read()).toEqual([])
  })

  test("a reader sees only its own datasets", async () => {
    const { feed, scene } = createScene()
    const orders = reader(feed, ["orders"])
    await orders.read()

    scene.pending = [summary("orders", "v2"), summary("customers", "v9")]
    scene.advance(FRESH_FOR_MS)

    expect(await orders.read()).toEqual([summary("orders", "v2")])
  })

  test("what a reader left unread keeps the newest version of each dataset", async () => {
    const { feed, scene } = createScene()
    const eager = reader(feed, ["orders"])
    const late = reader(feed, ["orders"])
    await eager.read()

    scene.pending = [summary("orders", "v2")]
    scene.advance(FRESH_FOR_MS)
    await eager.read()

    scene.pending = [summary("orders", "v3")]
    scene.advance(FRESH_FOR_MS)
    await eager.read()

    expect(await late.read()).toEqual([summary("orders", "v3")])
  })

  // Reproduce: set `readAt` before the query; the reader after the failure sees a fresh feed and
  // the query is not repeated.
  test("a failed read costs nothing: the next one asks again, from the same cursor", async () => {
    const { feed, reads, scene } = createScene()
    const orders = reader(feed, ["orders"])
    await orders.read()
    scene.advance(FRESH_FOR_MS)

    scene.answer = async () => {
      throw new Error("catalog unavailable")
    }
    const failure = await orders.read().catch((error) => error)
    expect(failure.message).toBe("catalog unavailable")

    scene.answer = null
    await orders.read()

    expect(reads.map((read) => read.cursor)).toEqual([null, "1", "1"])
  })

  test("tells every reader when its cursor stops being a position in the lake", async () => {
    const { feed, reads, scene } = createScene()
    const lost: string[] = []
    const first = reader(feed, ["orders"], () => lost.push("first"))
    reader(feed, ["customers"], () => lost.push("second"))
    await first.read()
    scene.advance(FRESH_FOR_MS)

    let answers = 0
    scene.answer = async () => (answers++ === 0 ? null : { cursor: "fresh", versions: [] })
    await first.read()

    expect(lost).toEqual(["first", "second"])
    expect(reads.at(-1)?.cursor).toBeNull()
  })
})
