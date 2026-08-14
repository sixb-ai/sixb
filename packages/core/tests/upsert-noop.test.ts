import { describe, expect, mock, test } from "bun:test"
import { defineObjectType, link, prop, SixbHost } from "../src"
import type { DomainEventService } from "../src/events"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps, waitFor } from "./test-runtime-deps"

const Target = defineObjectType({
  id: "noop-target",
  name: "No-op target",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Source = defineObjectType({
  id: "noop-source",
  name: "No-op source",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
  links: [
    link("targets", Target, {
      cardinality: "many",
      properties: [prop("role", "string"), prop("amount", "decimal")],
    }),
  ],
})

function createRuntime() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({ ontology: [Source, Target], ...deps })
  const sixb = createTestSixb(host)
  // Mutations write durable outbox facts, so publication is the observable delivery boundary.
  const events = host.events as DomainEventService
  const publish = events.publishEnvelopes.bind(events)
  const publishSpy = mock(publish)
  events.publishEnvelopes = publishSpy
  return { publishSpy, deps, sixb }
}

describe("upsert no-op suppression", () => {
  test("a repeated object upsert preserves state and emits no update", async () => {
    const { publishSpy, deps, sixb } = createRuntime()
    const created = await sixb.objects.upsert("noop-source", { id: "source-1", name: "Source" })

    await waitFor(
      () => sixb.events.read(),
      (published) => published.length === 1
    )
    publishSpy.mockClear()
    const replayed = await sixb.objects.upsert("noop-source", {
      id: "source-1",
      name: "Source",
    })

    expect(publishSpy).not.toHaveBeenCalled()
    expect(replayed).toEqual(created)
    expect(
      await deps.storage.objects.getByPrimaryId({
        projectId: sixb.execution.projectId,
        objectTypeId: "noop-source",
        primaryId: "source-1",
      })
    ).toEqual(created)
    expect(await sixb.events.read({ types: ["object.updated"] })).toHaveLength(0)
  })

  test("an object batch emits only real changes and preserves result order", async () => {
    const { publishSpy, deps, sixb } = createRuntime()
    const source1 = await sixb.objects.upsert("noop-source", { id: "source-1", name: "One" })
    await sixb.objects.upsert("noop-source", { id: "source-2", name: "Before" })

    await waitFor(
      () => sixb.events.read(),
      (published) => published.length === 2
    )
    publishSpy.mockClear()
    const results = await sixb.objects.upsertBatch("noop-source", [
      { properties: { id: "source-1", name: "One" } },
      { properties: { id: "source-2", name: "After" } },
      { properties: { id: "source-3", name: "Three" } },
    ])

    await waitFor(
      () => sixb.events.read(),
      (published) => published.length === 4
    )
    expect(publishSpy).toHaveBeenCalledTimes(1)
    expect(publishSpy.mock.calls[0]?.[0]).toHaveLength(2)
    expect(results.every((result) => result.ok)).toBe(true)
    expect(results.map((result) => (result.ok ? result.value.primaryId : undefined))).toEqual([
      "source-1",
      "source-2",
      "source-3",
    ])
    if (results[0].ok) expect(results[0].value).toEqual(source1)
    expect(await sixb.events.read({ types: ["object.updated"] })).toHaveLength(1)

    const rowsBeforeReplay = await deps.storage.objects.getByPrimaryIdBatch({
      projectId: sixb.execution.projectId,
      items: [
        { objectTypeId: "noop-source", primaryId: "source-1" },
        { objectTypeId: "noop-source", primaryId: "source-2" },
        { objectTypeId: "noop-source", primaryId: "source-3" },
      ],
    })

    publishSpy.mockClear()
    const replayed = await sixb.objects.upsertBatch("noop-source", [
      { properties: { id: "source-1", name: "One" } },
      { properties: { id: "source-2", name: "After" } },
      { properties: { id: "source-3", name: "Three" } },
    ])

    expect(publishSpy).not.toHaveBeenCalled()
    expect(replayed.map((result) => result.ok)).toEqual([true, true, true])
    for (const result of replayed) {
      if (!result.ok) continue
      const rowBeforeReplay = rowsBeforeReplay.get(`noop-source:${result.value.primaryId}`)
      expect(rowBeforeReplay).toBeDefined()
      if (rowBeforeReplay) expect(result.value).toEqual(rowBeforeReplay)
    }
  })

  test("a repeated link upsert preserves state and emits no update", async () => {
    const { publishSpy, deps, sixb } = createRuntime()
    await sixb.objects.upsert("noop-source", { id: "source-1", name: "Source" })
    await sixb.objects.upsert("noop-target", { id: "target-1" })
    await sixb.objects.upsertLink("noop-source", "source-1", "targets", {
      targetTypeId: "noop-target",
      targetId: "target-1",
      properties: { role: "primary" },
    })
    const [created] = await deps.storage.objects.listLinks({
      projectId: sixb.execution.projectId,
      objectTypeId: "noop-source",
      objectId: "source-1",
      linkId: "targets",
    })

    await waitFor(
      () => sixb.events.read(),
      (published) => published.length === 3
    )
    publishSpy.mockClear()
    await sixb.objects.upsertLink("noop-source", "source-1", "targets", {
      targetTypeId: "noop-target",
      targetId: "target-1",
      properties: { role: "primary" },
    })

    expect(publishSpy).not.toHaveBeenCalled()
    expect(
      await deps.storage.objects.listLinks({
        projectId: sixb.execution.projectId,
        objectTypeId: "noop-source",
        objectId: "source-1",
        linkId: "targets",
      })
    ).toEqual([created])
    expect(await sixb.events.read({ types: ["link.updated"] })).toHaveLength(0)
  })

  test("canonicalizes decimal link properties before no-op detection and persistence", async () => {
    const { publishSpy, deps, sixb } = createRuntime()
    await sixb.objects.upsert("noop-source", { id: "source-1", name: "Source" })
    await sixb.objects.upsert("noop-target", { id: "target-1" })
    await sixb.objects.upsert("noop-target", { id: "target-2" })

    await sixb.objects.upsertLink("noop-source", "source-1", "targets", {
      targetTypeId: "noop-target",
      targetId: "target-1",
      properties: { amount: "+001.2300" },
    })

    await waitFor(
      () => sixb.events.read(),
      (published) => published.length === 4
    )
    publishSpy.mockClear()
    const results = await sixb.objects.upsertLinkBatch([
      {
        objectTypeId: "noop-source",
        sourceId: "source-1",
        linkId: "targets",
        target: {
          targetTypeId: "noop-target",
          targetId: "target-1",
          properties: { amount: "1.23" },
        },
      },
      {
        objectTypeId: "noop-source",
        sourceId: "source-1",
        linkId: "targets",
        target: {
          targetTypeId: "noop-target",
          targetId: "target-2",
          properties: { amount: "002.500" },
        },
      },
    ])

    await waitFor(
      () => sixb.events.read(),
      (published) => published.length === 5
    )
    expect(results.map((result) => result.ok)).toEqual([true, true])
    expect(publishSpy).toHaveBeenCalledTimes(1)
    expect(publishSpy.mock.calls[0]?.[0]).toHaveLength(1)

    const links = await deps.storage.objects.listLinks({
      projectId: sixb.execution.projectId,
      objectTypeId: "noop-source",
      objectId: "source-1",
      linkId: "targets",
    })
    expect(
      links
        .map((row) => [row.targetId, row.properties?.amount])
        .sort(([left], [right]) => String(left).localeCompare(String(right)))
    ).toEqual([
      ["target-1", "1.23"],
      ["target-2", "2.5"],
    ])
  })

  test("a link batch emits only real changes and skips an unchanged replay", async () => {
    const { publishSpy, deps, sixb } = createRuntime()
    await sixb.objects.upsert("noop-source", { id: "source-1", name: "Source" })
    await sixb.objects.upsert("noop-target", { id: "target-1" })
    await sixb.objects.upsert("noop-target", { id: "target-2" })
    await sixb.objects.upsertLink("noop-source", "source-1", "targets", {
      targetTypeId: "noop-target",
      targetId: "target-1",
    })

    const batch = [
      {
        objectTypeId: "noop-source",
        sourceId: "source-1",
        linkId: "targets",
        target: { targetTypeId: "noop-target", targetId: "target-1" },
      },
      {
        objectTypeId: "noop-source",
        sourceId: "source-1",
        linkId: "targets",
        target: { targetTypeId: "noop-target", targetId: "target-2" },
      },
    ] as const

    await waitFor(
      () => sixb.events.read(),
      (published) => published.length === 4
    )
    publishSpy.mockClear()
    const results = await sixb.objects.upsertLinkBatch(batch)

    await waitFor(
      () => sixb.events.read(),
      (published) => published.length === 5
    )
    expect(results.map((result) => result.ok)).toEqual([true, true])
    expect(publishSpy).toHaveBeenCalledTimes(1)
    expect(publishSpy.mock.calls[0]?.[0]).toHaveLength(1)
    expect(await sixb.events.read({ types: ["link.updated"] })).toHaveLength(0)

    const linksBeforeReplay = await deps.storage.objects.listLinks({
      projectId: sixb.execution.projectId,
      objectTypeId: "noop-source",
      objectId: "source-1",
      linkId: "targets",
    })

    publishSpy.mockClear()
    expect((await sixb.objects.upsertLinkBatch(batch)).map((result) => result.ok)).toEqual([
      true,
      true,
    ])
    expect(publishSpy).not.toHaveBeenCalled()
    expect(
      await deps.storage.objects.listLinks({
        projectId: sixb.execution.projectId,
        objectTypeId: "noop-source",
        objectId: "source-1",
        linkId: "targets",
      })
    ).toEqual(linksBeforeReplay)
  })
})
