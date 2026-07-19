import { describe, expect, test } from "bun:test"
import {
  col,
  defineDataset,
  defineLinkProjection,
  defineObjectType,
  defineProjection,
  InMemoryStorage,
  OntologyRegistry,
  prop,
} from "../src"
import { createOntologyMaterializer, ProjectionRegistry } from "../src/materializer"
import { type SourceReplacementLinkState, StorageTransactionError } from "../src/storage"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import {
  atomic,
  createMaterializerFixture,
  Device,
  entries,
  replacement,
  sourceEntry,
  sourceEntryWithParent,
} from "./materializer-fixture"

const ref = (primaryId: string) => ({ objectTypeId: "Device", primaryId })

describe("ontology materializer projection replacement", () => {
  test("classifies each replacement identity once and is page/order deterministic", async () => {
    const run = async (statePageRows: number, reversed: boolean) => {
      const { materializer, storage } = createMaterializerFixture({
        dependencies: {
          batching: {
            sourceStageRows: 2,
            sourceStageBytes: statePageRows === 1 ? 1 : 1_000_000,
            statePageRows,
            planChunkRows: statePageRows === 1 ? 1 : 3,
            planChunkBytes: statePageRows === 1 ? 1 : 1_000_000,
          },
        },
      })
      const streamCalls: string[] = []
      const classifications: string[] = []
      const buffers = new Map<string, number>()
      const applyChunkSizes: number[] = []
      getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
        beforeRead(boundary) {
          if (boundary.startsWith("source-replacement.")) streamCalls.push(boundary)
        },
        observeWork(records) {
          for (const record of records) {
            if (record.kind === "classification") classifications.push(record.recordKey)
          }
        },
        observeBuffer(boundary, rows) {
          buffers.set(boundary, Math.max(buffers.get(boundary) ?? 0, rows))
          if (boundary === "apply.chunk") applyChunkSizes.push(rows)
        },
      })
      const values = Array.from({ length: 200 }, (_, index) =>
        index === 0
          ? sourceEntry("00", "device-00")
          : sourceEntryWithParent(
              String(index).padStart(2, "0"),
              `device-${index}`,
              String(index - 1).padStart(2, "0")
            )
      )
      const result = await materializer.projections.replace(
        replacement(
          "one-pass",
          "2026-01-01T00:00:00Z",
          reversed ? [...values].reverse() : values,
          "one-pass-run"
        )
      )
      const claimed = await storage.ontology.outbox.claim({
        projectId: "project",
        now: "2027-01-01T00:00:00Z",
        limit: 1_000,
        leaseId: `lease-${statePageRows}-${reversed}`,
        leaseExpiresAt: "2027-01-01T01:00:00Z",
      })
      return {
        result,
        streamCalls,
        classifications,
        buffers,
        applyChunkSizes,
        events: claimed
          .map((row) => row.envelope)
          .sort((a, b) => a.commitOrdinal - b.commitOrdinal),
      }
    }

    const tiny = await run(1, true)
    const broad = await run(100, false)
    expect(tiny.streamCalls).toEqual(["source-replacement.object", "source-replacement.link"])
    expect(new Set(tiny.classifications).size).toBe(tiny.classifications.length)
    expect(tiny.classifications).toHaveLength(399)
    expect(tiny.result).toEqual(broad.result)
    expect(tiny.events).toEqual(broad.events)
    expect(tiny.buffers.get("replacement.object.page")).toBeLessThanOrEqual(1)
    expect(tiny.buffers.get("replacement.link.page")).toBeLessThanOrEqual(1)
    expect(tiny.buffers.get("work.apply.page")).toBeLessThanOrEqual(1)
    expect(tiny.buffers.get("work.event.page")).toBeLessThanOrEqual(1)
    expect(tiny.buffers.get("work.stage")).toBeLessThanOrEqual(1)
    expect(tiny.buffers.get("apply.chunk")).toBeLessThanOrEqual(1)
    expect(broad.applyChunkSizes).toContain(3)
  })

  test("records one classification for every unchanged replacement identity", async () => {
    const { materializer, storage } = createMaterializerFixture({
      dependencies: { batching: { statePageRows: 1 } },
    })
    const values = [sourceEntryWithParent("one", "one", "two"), sourceEntry("two", "two")]
    await materializer.projections.replace(
      replacement("unchanged-v1", "2026-01-01T00:00:00Z", values)
    )
    const classifications: string[] = []
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      observeWork(records) {
        for (const record of records) {
          if (record.kind === "classification") classifications.push(record.recordKey)
        }
      },
    })
    const result = await materializer.projections.replace(
      replacement("unchanged-v2", "2026-01-02T00:00:00Z", values)
    )
    expect(result.counts).toMatchObject({ objectsUnchanged: 2, linksUnchanged: 1 })
    expect(classifications).toHaveLength(3)
    expect(new Set(classifications).size).toBe(3)
  })

  test("finishes all semantic reads before the first durable replacement write", async () => {
    const { materializer, storage } = createMaterializerFixture({
      dependencies: { batching: { statePageRows: 1, planChunkRows: 2 } },
    })
    let wrote = false
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      beforeRead(boundary) {
        if (wrote) throw new Error(`own-write visibility dependency at ${boundary}`)
      },
      beforeWrite(boundary) {
        if (boundary !== "finalize" && boundary !== "source.activate") wrote = true
      },
    })
    const result = await materializer.projections.replace(
      replacement("isolated", "2026-01-01T00:00:00Z", [
        sourceEntryWithParent("one", "one", "two"),
        sourceEntry("two", "two"),
      ])
    )
    expect(result.counts).toMatchObject({ objectsCreated: 2, linksCreated: 1 })
  })

  test("drains exact work in safe physical phases before outbox and activation", async () => {
    const { materializer, storage } = createMaterializerFixture({
      dependencies: { batching: { statePageRows: 1, planChunkRows: 50 } },
    })
    await materializer.projections.replace(
      replacement("physical-v1", "2026-01-01T00:00:00Z", [
        sourceEntryWithParent("one", "one", "two"),
        sourceEntry("two", "two"),
      ])
    )
    const writes: string[] = []
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      beforeWrite(boundary) {
        writes.push(boundary)
      },
    })
    await materializer.projections.replace(replacement("physical-v2", "2026-01-02T00:00:00Z", []))
    const linkDelete = writes.indexOf("effective.link.delete")
    const objectDelete = writes.indexOf("effective.object.delete")
    const outbox = writes.indexOf("outbox.insert")
    const activation = writes.indexOf("source.activate")
    expect(linkDelete).toBeGreaterThanOrEqual(0)
    expect(linkDelete).toBeLessThan(objectDelete)
    expect(objectDelete).toBeLessThan(outbox)
    expect(outbox).toBeLessThan(activation)
  })

  test("stages lazily, activates once, withdraws missing source, and preserves dormant edits", async () => {
    const { materializer, storage } = createMaterializerFixture({
      dependencies: {
        batching: {
          sourceStageRows: 1,
          sourceStageBytes: 1,
          statePageRows: 1,
          planChunkRows: 1,
          planChunkBytes: 1,
        },
      },
    })
    let produced = 0
    async function* lazy() {
      for (let index = 0; index < 40; index += 1) {
        produced += 1
        yield sourceEntry(String(index), `device-${index}`)
      }
    }
    const first = await materializer.projections.replace({
      source: { projectionId: "devices" },
      datasetVersion: {
        datasetId: "devices",
        versionId: "v1",
        createdAt: "2026-01-01T00:00:00Z",
      },
      projectionRunId: "run-v1",
      entries: lazy(),
    })
    expect(produced).toBe(40)
    expect(first.counts.objectsCreated).toBe(40)

    await materializer.edits.commit(
      atomic("edit", [
        {
          id: "patch",
          kind: "object.patch",
          ref: ref("0"),
          set: { name: "edited" },
          unset: [],
          reset: [],
        },
      ])
    )
    const second = await materializer.projections.replace(
      replacement("v2", "2026-01-02T00:00:00Z", [])
    )
    expect(second.counts.objectsDeleted).toBe(40)
    expect(
      await storage.objects.getByPrimaryId({
        projectId: "project",
        objectTypeId: "Device",
        primaryId: "0",
      })
    ).toBeNull()

    await materializer.projections.replace(
      replacement("v3", "2026-01-03T00:00:00Z", [sourceEntry("0", "source-returned")])
    )
    expect(
      (
        await storage.objects.getByPrimaryId({
          projectId: "project",
          objectTypeId: "Device",
          primaryId: "0",
        })
      )?.properties.name
    ).toBe("edited")
  })

  test("uses UTF-8 bytes for source stage thresholds", async () => {
    const first = sourceEntry("😀1", "😀😀")
    const stagedRow = {
      root: first.root,
      assertion: first.assertions[0],
      stagingOrdinal: 0,
    }
    const rowBytes = new TextEncoder().encode(JSON.stringify(stagedRow)).byteLength
    const { materializer, storage } = createMaterializerFixture({
      dependencies: {
        batching: { sourceStageRows: 10, sourceStageBytes: rowBytes * 2 - 1 },
      },
    })
    const batches: number[] = []
    const stage = storage.ontology.sources.stage.bind(storage.ontology.sources)
    storage.ontology.sources.stage = async (input) => {
      if (input.rows.length > 0) batches.push(input.rows.length)
      return stage(input)
    }
    await materializer.projections.replace(
      replacement("unicode-stage", "2026-01-01T00:00:00Z", [first, sourceEntry("😀2", "😀😀")])
    )
    expect(batches).toEqual([1, 1])
  })

  test("fast replay does not consume entries and stale/ambiguous watermarks fail before staging", async () => {
    const { materializer } = createMaterializerFixture()
    const first = await materializer.projections.replace(
      replacement("v1", "2026-01-02T00:00:00Z", [sourceEntry("one", "one")])
    )
    let consumed = false
    async function* shouldNotRun() {
      consumed = true
      yield sourceEntry("bad", "bad")
    }
    const replay = await materializer.projections.replace({
      source: { projectionId: "devices" },
      datasetVersion: {
        datasetId: "devices",
        versionId: "v1",
        createdAt: "2026-01-02T00:00:00Z",
      },
      projectionRunId: "another-run",
      entries: shouldNotRun(),
    })
    expect(first.created).toBe(true)
    expect(replay.created).toBe(false)
    expect(consumed).toBe(false)

    await expect(
      materializer.projections.replace(replacement("older", "2026-01-01T00:00:00Z", []))
    ).rejects.toMatchObject({ kind: "projection-fence" })
    await expect(
      materializer.projections.replace(replacement("ambiguous", "2026-01-02T00:00:00Z", []))
    ).rejects.toMatchObject({ kind: "projection-fence" })
  })

  test("rejects duplicate roots across stage batches and discards cancelled candidates", async () => {
    const { materializer, storage } = createMaterializerFixture({
      dependencies: { batching: { sourceStageRows: 1 } },
    })
    await expect(
      materializer.projections.replace({
        source: { projectionId: "devices" },
        datasetVersion: {
          datasetId: "devices",
          versionId: "duplicates",
          createdAt: "2026-01-01T00:00:00Z",
        },
        projectionRunId: "duplicates",
        entries: entries([sourceEntry("one", "one"), sourceEntry("one", "one")]),
      })
    ).rejects.toThrow("repeats root")
    expect(
      await storage.ontology.sources.cleanupInactive({
        projectId: "project",
        olderThan: "2027-01-01T00:00:00Z",
        limit: 10,
      })
    ).toBe(0)

    const controller = new AbortController()
    async function* cancelling() {
      yield sourceEntry("one", "one")
      controller.abort()
      yield sourceEntry("two", "two")
    }
    await expect(
      materializer.projections.replace({
        source: { projectionId: "devices" },
        datasetVersion: {
          datasetId: "devices",
          versionId: "cancelled",
          createdAt: "2026-01-02T00:00:00Z",
        },
        projectionRunId: "cancelled",
        entries: cancelling(),
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(
      await storage.ontology.sources.cleanupInactive({
        projectId: "project",
        olderThan: "2027-01-01T00:00:00Z",
        limit: 10,
      })
    ).toBe(0)
  })

  test("retains an in-flight candidate across concurrent cleanup with an advancing clock", async () => {
    const times = [new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T01:00:00Z")]
    let generation = 0
    const { materializer, storage } = createMaterializerFixture({
      dependencies: {
        batching: { sourceStageRows: 1 },
        clock: () => times.shift() ?? new Date("2026-01-01T02:00:00Z"),
        generationId: () => `slow-generation-${++generation}`,
      },
    })
    const firstAbort = new AbortController()
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstReached!: () => void
    const firstReachedPause = new Promise<void>((resolve) => {
      firstReached = resolve
    })
    async function* slowFirst() {
      yield sourceEntry("one", "one")
      yield sourceEntry("two", "two")
      firstReached()
      await firstBlocked
    }
    const first = materializer.projections.replace({
      source: { projectionId: "devices" },
      datasetVersion: {
        datasetId: "devices",
        versionId: "slow-first",
        createdAt: "2026-01-01T00:00:00Z",
      },
      projectionRunId: "slow-first-run",
      entries: slowFirst(),
      signal: firstAbort.signal,
    })
    await firstReachedPause

    await materializer.projections.replace({
      source: { projectionId: "devices" },
      datasetVersion: {
        datasetId: "devices",
        versionId: "slow-second",
        createdAt: "2026-01-01T01:00:00Z",
      },
      projectionRunId: "slow-second-run",
      entries: entries([]),
    })
    const restaged = await storage.ontology.sources.stage({
      projectId: "project",
      source: { projectionId: "devices" },
      generationId: "slow-generation-1",
      stagedAt: "2026-01-01T00:00:00.000Z",
      rows: [
        {
          root: { kind: "object", ref: ref("one") },
          assertion: {
            kind: "object",
            ref: ref("one"),
            properties: { name: "one" },
          },
          stagingOrdinal: 0,
        },
      ],
    })
    expect(restaged).toEqual({ inserted: 0, unchanged: 1 })
    const firstRejected = first.then(
      () => new Error("first replacement unexpectedly completed"),
      (error: unknown) => error
    )
    firstAbort.abort(new DOMException("stop first", "AbortError"))
    releaseFirst()
    expect(await firstRejected).toMatchObject({ name: "AbortError", message: "stop first" })
  })

  test("preserves the active generation after late malformed and cancelled ingress", async () => {
    const { materializer, storage } = createMaterializerFixture()
    await materializer.projections.replace(
      replacement("stable-v1", "2026-01-01T00:00:00Z", [sourceEntry("one", "stable")])
    )
    const activeBefore = await storage.ontology.sources.getActive({
      projectId: "project",
      source: { projectionId: "devices" },
    })

    async function* malformedLate() {
      yield sourceEntry("one", "candidate")
      const invalidRef = { source: ref("one"), linkId: "parent", target: ref("one") }
      yield {
        root: { kind: "link" as const, ref: invalidRef },
        assertions: [{ kind: "link" as const, ref: invalidRef }],
      }
    }
    await expect(
      materializer.projections.replace({
        ...replacement("malformed-v2", "2026-01-02T00:00:00Z", []),
        entries: malformedLate(),
      })
    ).rejects.toThrow("requires an object root")

    const controller = new AbortController()
    async function* cancelledLate() {
      yield sourceEntry("one", "cancelled")
      controller.abort(new DOMException("late cancellation", "AbortError"))
      yield sourceEntry("two", "two")
    }
    await expect(
      materializer.projections.replace({
        ...replacement("cancelled-v3", "2026-01-03T00:00:00Z", []),
        entries: cancelledLate(),
        signal: controller.signal,
      })
    ).rejects.toThrow("late cancellation")

    const activeAfter = await storage.ontology.sources.getActive({
      projectId: "project",
      source: { projectionId: "devices" },
    })
    expect(activeAfter?.activeGenerationId).toBe(activeBefore?.activeGenerationId)
    expect(activeAfter?.datasetVersion.versionId).toBe("stable-v1")
    expect(
      await storage.objects.getByPrimaryId({
        projectId: "project",
        objectTypeId: "Device",
        primaryId: "one",
      })
    ).toMatchObject({ properties: { name: "stable" } })
  })

  test("replaces cardinality-one source links and honors edit delete/reset authority", async () => {
    const { materializer, storage } = createMaterializerFixture({
      dependencies: { batching: { statePageRows: 1, planChunkRows: 1 } },
    })
    await materializer.projections.replace(
      replacement("v1", "2026-01-01T00:00:00Z", [
        sourceEntryWithParent("one", "one", "two"),
        sourceEntry("two", "two"),
      ])
    )
    expect(
      (
        await storage.objects.listLinks({
          projectId: "project",
          objectTypeId: "Device",
          objectId: "one",
        })
      )[0].targetId
    ).toBe("two")

    await materializer.projections.replace(
      replacement("v2", "2026-01-02T00:00:00Z", [
        sourceEntryWithParent("one", "one", "three"),
        sourceEntry("two", "two"),
        sourceEntry("three", "three"),
      ])
    )
    expect(
      (
        await storage.objects.listLinks({
          projectId: "project",
          objectTypeId: "Device",
          objectId: "one",
        })
      ).map((link) => link.targetId)
    ).toEqual(["three"])

    const linkRef = {
      source: ref("one"),
      linkId: "parent",
      target: ref("three"),
    }
    await materializer.edits.commit(
      atomic("delete-source-link", [{ id: "delete", kind: "link.delete", ref: linkRef }])
    )
    expect(
      await storage.objects.listLinks({
        projectId: "project",
        objectTypeId: "Device",
        objectId: "one",
      })
    ).toEqual([])
    await materializer.projections.replace(
      replacement("v3", "2026-01-03T00:00:00Z", [
        sourceEntryWithParent("one", "one", "three"),
        sourceEntry("three", "three"),
      ])
    )
    expect(
      await storage.objects.listLinks({
        projectId: "project",
        objectTypeId: "Device",
        objectId: "one",
      })
    ).toEqual([])
    await materializer.edits.commit(
      atomic("reset-source-link", [{ id: "reset", kind: "link.reset", ref: linkRef }])
    )
    expect(
      (
        await storage.objects.listLinks({
          projectId: "project",
          objectTypeId: "Device",
          objectId: "one",
        })
      ).map((link) => link.targetId)
    ).toEqual(["three"])
  })

  test("rejects multiple replacement links in one cardinality-one scope for tiny and default pages", async () => {
    const conflictingRoot = {
      root: { kind: "object" as const, ref: ref("one") },
      assertions: [
        { kind: "object" as const, ref: ref("one"), properties: { name: "one" } },
        {
          kind: "link" as const,
          ref: { source: ref("one"), linkId: "parent", target: ref("two") },
        },
        {
          kind: "link" as const,
          ref: { source: ref("one"), linkId: "parent", target: ref("three") },
        },
      ],
    }
    for (const statePageRows of [1, 1_000]) {
      const { materializer } = createMaterializerFixture({
        dependencies: { batching: { statePageRows } },
      })
      await expect(
        materializer.projections.replace(
          replacement(`cardinality-${statePageRows}`, "2026-01-01T00:00:00Z", [
            conflictingRoot,
            sourceEntry("two", "two"),
            sourceEntry("three", "three"),
          ])
        )
      ).rejects.toThrow("cardinality one")
    }
  })

  test("validates a page-split replacement scope against an unchanged edit-created competitor", async () => {
    const { materializer } = createMaterializerFixture({
      dependencies: { batching: { statePageRows: 1 } },
    })
    await materializer.projections.replace(
      replacement("competitor-v1", "2026-01-01T00:00:00Z", [
        sourceEntry("one", "one"),
        sourceEntry("two", "two"),
        sourceEntry("three", "three"),
      ])
    )
    await materializer.edits.commit(
      atomic("competitor-edit", [
        {
          id: "link",
          kind: "link.upsert",
          ref: { source: ref("one"), linkId: "parent", target: ref("two") },
        },
      ])
    )
    await expect(
      materializer.projections.replace(
        replacement("competitor-v2", "2026-01-02T00:00:00Z", [
          sourceEntryWithParent("one", "one", "three"),
          sourceEntry("two", "two"),
          sourceEntry("three", "three"),
        ])
      )
    ).rejects.toThrow("cardinality one")
  })

  test("keeps replacement events and cardinality correct when a provider shuffles emitted links", async () => {
    const { materializer, storage } = createMaterializerFixture({
      dependencies: { batching: { statePageRows: 1 } },
    })
    const materializations = storage.ontology.materializations
    const original = materializations.streamSourceReplacementState.bind(materializations)
    let shuffled = false
    materializations.streamSourceReplacementState = (input) => {
      const streamed = original(input)
      if (input.entityKind !== "link") return streamed
      return {
        async *[Symbol.asyncIterator]() {
          const links: SourceReplacementLinkState[] = []
          for await (const page of streamed) links.push(...page.links)
          links.reverse()
          shuffled = links.length > 1
          for (const link of links) yield { objects: [], links: [link], linkScopes: [] }
        },
      }
    }
    const result = await materializer.projections.replace(
      replacement("shuffled-links", "2026-01-01T00:00:00Z", [
        sourceEntryWithParent("one", "one", "three"),
        sourceEntryWithParent("two", "two", "three"),
        sourceEntry("three", "three"),
      ])
    )
    expect(shuffled).toBe(true)
    expect(result.counts).toMatchObject({ linksCreated: 2 })
    const events = await storage.ontology.outbox.claim({
      projectId: "project",
      now: "2027-01-01T00:00:00Z",
      limit: 20,
      leaseId: "shuffled-events",
      leaseExpiresAt: "2027-01-01T01:00:00Z",
    })
    expect(
      events
        .map((row) => row.envelope)
        .sort((left, right) => left.commitOrdinal - right.commitOrdinal)
        .flatMap((event) => (event.type === "link.created" ? [event.payload.sourceId] : []))
    ).toEqual(["one", "two"])

    const conflict = createMaterializerFixture({
      dependencies: { batching: { statePageRows: 1 } },
    })
    const conflictStorage = conflict.storage.ontology.materializations
    const conflictOriginal = conflictStorage.streamSourceReplacementState.bind(conflictStorage)
    conflictStorage.streamSourceReplacementState = (input) => {
      const streamed = conflictOriginal(input)
      if (input.entityKind !== "link") return streamed
      return {
        async *[Symbol.asyncIterator]() {
          const links: SourceReplacementLinkState[] = []
          for await (const page of streamed) links.push(...page.links)
          for (const link of links.reverse()) {
            yield { objects: [], links: [link], linkScopes: [] }
          }
        },
      }
    }
    await expect(
      conflict.materializer.projections.replace(
        replacement("shuffled-conflict", "2026-01-01T00:00:00Z", [
          {
            root: { kind: "object", ref: ref("one") },
            assertions: [
              { kind: "object", ref: ref("one"), properties: { name: "one" } },
              {
                kind: "link",
                ref: { source: ref("one"), linkId: "parent", target: ref("two") },
              },
              {
                kind: "link",
                ref: { source: ref("one"), linkId: "parent", target: ref("three") },
              },
            ],
          },
          sourceEntry("two", "two"),
          sourceEntry("three", "three"),
        ])
      )
    ).rejects.toThrow("cardinality one")
  })

  test("aborts activation writes transactionally and performs bounded orphan cleanup", async () => {
    const controller = new AbortController()
    const { materializer, storage } = createMaterializerFixture()
    await storage.ontology.sources.stage({
      projectId: "project",
      source: { projectionId: "devices" },
      generationId: "orphan",
      stagedAt: "2025-01-01T00:00:00.000Z",
      rows: [],
    })
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      beforeWrite(boundary) {
        if (boundary === "outbox.insert") controller.abort()
      },
    })
    await expect(
      materializer.projections.replace({
        ...replacement("aborted-activation", "2026-01-01T00:00:00Z", [sourceEntry("one", "one")]),
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(
      await storage.objects.getByPrimaryId({
        projectId: "project",
        objectTypeId: "Device",
        primaryId: "one",
      })
    ).toBeNull()
    expect(
      await storage.ontology.sources.getActive({
        projectId: "project",
        source: { projectionId: "devices" },
      })
    ).toBeNull()
    expect(
      await storage.ontology.sources.cleanupInactive({
        projectId: "project",
        olderThan: "2027-01-01T00:00:00Z",
        limit: 100,
      })
    ).toBe(0)
  })

  test("rolls back a no-event activation when abort arrives during awaited bookkeeping", async () => {
    const controller = new AbortController()
    const { materializer, storage } = createMaterializerFixture()
    await materializer.projections.replace(
      replacement("abort-bookkeeping-v1", "2026-01-01T00:00:00Z", [sourceEntry("one", "one")])
    )
    const activeBefore = await storage.ontology.sources.getActive({
      projectId: "project",
      source: { projectionId: "devices" },
    })
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      async applyBookkeeping() {
        await Promise.resolve()
        controller.abort(new DOMException("late bookkeeping abort", "AbortError"))
      },
    })
    await expect(
      materializer.projections.replace({
        ...replacement("abort-bookkeeping-v2", "2026-01-02T00:00:00Z", [sourceEntry("one", "one")]),
        signal: controller.signal,
      })
    ).rejects.toThrow("late bookkeeping abort")
    const activeAfter = await storage.ontology.sources.getActive({
      projectId: "project",
      source: { projectionId: "devices" },
    })
    expect(activeAfter?.activeGenerationId).toBe(activeBefore?.activeGenerationId)
    expect(activeAfter?.datasetVersion.versionId).toBe("abort-bookkeeping-v1")
    expect(
      await storage.ontology.commits.getByIdempotencyKey({
        projectId: "project",
        idempotencyKey: `projection:devices:replace:abort-bookkeeping-v2:${activeBefore?.projectionRevision}`,
      })
    ).toBeNull()
  })

  test("reuses one candidate generation across projection serialization retry", async () => {
    const storage = new InMemoryStorage()
    let generationCalls = 0
    let finalizeAttempts = 0
    const { materializer } = createMaterializerFixture({
      storage,
      dependencies: {
        generationId: () => {
          generationCalls += 1
          return "stable-retry-generation"
        },
      },
    })
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      beforeWrite(boundary) {
        if (boundary === "finalize" && finalizeAttempts++ === 0) {
          throw new StorageTransactionError("retry projection", {
            code: "serialization_failure",
          })
        }
      },
    })
    await materializer.projections.replace(
      replacement("projection-retry", "2026-01-01T00:00:00Z", [sourceEntry("one", "one")])
    )
    expect(generationCalls).toBe(1)
    expect(finalizeAttempts).toBe(2)
    expect(
      (
        await storage.ontology.sources.getActive({
          projectId: "project",
          source: { projectionId: "devices" },
        })
      )?.activeGenerationId
    ).toBe("stable-retry-generation")
  })

  test("executes a standalone link projection replacement", async () => {
    const joins = defineDataset("device-peers", {
      schema: [col("source_id", "string"), col("target_id", "string")],
    })
    const definition = defineLinkProjection("device-peers", Device.l.peers)
      .fromDataset(joins)
      .sourceField("source_id")
      .targetField("target_id")
    const ontology = new OntologyRegistry({ sources: [Device] })
    const projections = new ProjectionRegistry({
      projections: [definition],
      ontology,
      datasetsById: new Map([[joins.id, joins]]),
    })
    const storage = new InMemoryStorage()
    const materializer = createOntologyMaterializer({
      projectId: "project",
      ontology,
      projections,
      storage,
      dependencies: {
        clock: () => new Date("2026-01-02T00:00:00Z"),
        generationId: () => "standalone-link-generation",
      },
    })
    await materializer.edits.commit(
      atomic("standalone-link-endpoints", [
        {
          id: "one",
          kind: "object.create",
          ref: ref("one"),
          properties: { name: "one" },
        },
        {
          id: "two",
          kind: "object.create",
          ref: ref("two"),
          properties: { name: "two" },
        },
      ])
    )
    const linkRef = { source: ref("one"), linkId: "peers", target: ref("two") }
    const result = await materializer.projections.replace({
      source: { projectionId: "device-peers" },
      datasetVersion: {
        datasetId: "device-peers",
        versionId: "links-v1",
        createdAt: "2026-01-01T00:00:00Z",
      },
      projectionRunId: "standalone-link-run",
      entries: entries([
        {
          root: { kind: "link", ref: linkRef },
          assertions: [{ kind: "link", ref: linkRef }],
        },
      ]),
    })
    expect(result.counts).toMatchObject({ linksCreated: 1 })
    expect(
      await storage.objects.listLinks({
        projectId: "project",
        objectTypeId: "Device",
        objectId: "one",
      })
    ).toEqual([expect.objectContaining({ linkId: "peers", sourceId: "one", targetId: "two" })])
  })

  test("enforces resolved projection roots, property ownership, and unsupported link properties", async () => {
    const Owned = defineObjectType({
      id: "Owned",
      name: "Owned",
      properties: [
        prop("id", "string", { primary: true, required: true }),
        prop("owned", "string", { required: true }),
        prop("unowned", "string"),
      ],
    })
    const dataset = defineDataset("owned", {
      schema: [col("id", "string"), col("owned", "string")],
    })
    const definition = defineProjection("owned", Owned)
      .fromDataset(dataset)
      .properties({ id: "id", owned: "owned" })
    const ontology = new OntologyRegistry({ sources: [Owned] })
    const projections = new ProjectionRegistry({
      projections: [definition],
      ontology,
      datasetsById: new Map([[dataset.id, dataset]]),
    })
    const materializer = createOntologyMaterializer({
      projectId: "project",
      ontology,
      projections,
      storage: new InMemoryStorage(),
      dependencies: {
        clock: () => new Date("2026-01-01T00:00:00Z"),
        generationId: () => "owned-generation",
      },
    })
    await expect(
      materializer.projections.replace({
        source: { projectionId: "owned" },
        datasetVersion: {
          datasetId: "owned",
          versionId: "v1",
          createdAt: "2026-01-01T00:00:00Z",
        },
        projectionRunId: "owned-run",
        entries: entries([
          {
            root: { kind: "object", ref: { objectTypeId: "Owned", primaryId: "one" } },
            assertions: [
              {
                kind: "object",
                ref: { objectTypeId: "Owned", primaryId: "one" },
                properties: { owned: "yes", unowned: "no" },
              },
            ],
          },
        ]),
      })
    ).rejects.toThrow("unowned property")

    const { materializer: fixtureMaterializer } = createMaterializerFixture()
    await expect(
      fixtureMaterializer.projections.replace({
        ...replacement("wrong-root", "2026-01-01T00:00:00Z", []),
        entries: entries([
          {
            root: {
              kind: "link",
              ref: { source: ref("one"), linkId: "parent", target: ref("two") },
            },
            assertions: [
              {
                kind: "link",
                ref: { source: ref("one"), linkId: "parent", target: ref("two") },
              },
            ],
          },
        ]),
      })
    ).rejects.toThrow("requires an object root")
    await expect(
      fixtureMaterializer.projections.replace({
        ...replacement("link-properties", "2026-01-01T00:00:00Z", []),
        entries: entries([
          {
            ...sourceEntryWithParent("one", "one", "two"),
            assertions: sourceEntryWithParent("one", "one", "two").assertions.map((assertion) =>
              assertion.kind === "link" ? { ...assertion, properties: {} } : assertion
            ),
          },
          sourceEntry("two", "two"),
        ]),
      })
    ).rejects.toThrow("does not map link assertion properties")
  })
})
