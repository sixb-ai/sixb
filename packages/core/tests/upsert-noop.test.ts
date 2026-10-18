import { describe, expect, test } from "bun:test"
import { defineObjectType, link, prop } from "../src"
import { objectBatchKey } from "../src/storage"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

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

/**
 * Every published event is first a durable outbox fact, so the facts a mutation adds are exactly
 * the events it will emit. Reading them needs no wait for asynchronous delivery.
 */
function createRuntime() {
  const deps = createTestRuntimeDeps()
  const sixb = createTestSixb({ ontology: [Source, Target], ...deps })
  const facts = () => [
    ...getInMemoryOntologyStorageTestingAdapter(deps.storage.ontology).snapshot().outbox.values(),
  ]
  /** The event types, sorted, that the mutations since the last call added to the outbox. */
  let seen = 0
  const newFacts = () => {
    const all = facts()
    const added = all.slice(seen).map((row) => row.event.type)
    seen = all.length
    return added.sort()
  }
  const listTargets = () =>
    deps.storage.objects.listLinks({
      projectId: sixb.execution.projectId,
      objectTypeId: "noop-source",
      objectId: "source-1",
      linkId: "targets",
    })
  return { deps, sixb, newFacts, listTargets }
}

describe("upsert no-op suppression", () => {
  test("repeated object upserts preserve state and emit only real changes, in result order", async () => {
    const { deps, sixb, newFacts } = createRuntime()
    const source1 = await sixb.objects.upsert("noop-source", { id: "source-1", name: "One" })
    await sixb.objects.upsert("noop-source", { id: "source-2", name: "Before" })
    expect(newFacts()).toEqual(["object.created", "object.created"])

    expect(await sixb.objects.upsert("noop-source", { id: "source-1", name: "One" })).toEqual(
      source1
    )
    expect(newFacts()).toEqual([])

    const batch = [
      { properties: { id: "source-1", name: "One" } },
      { properties: { id: "source-2", name: "After" } },
      { properties: { id: "source-3", name: "Three" } },
    ]
    const results = await sixb.objects.upsertBatch("noop-source", batch)
    expect(results.map((result) => (result.ok ? result.value.primaryId : undefined))).toEqual([
      "source-1",
      "source-2",
      "source-3",
    ])
    if (results[0].ok) expect(results[0].value).toEqual(source1)
    expect(newFacts()).toEqual(["object.created", "object.updated"])

    const rowsBeforeReplay = await deps.storage.objects.getByPrimaryIdBatch({
      projectId: sixb.execution.projectId,
      items: ["source-1", "source-2", "source-3"].map((primaryId) => ({
        objectTypeId: "noop-source",
        primaryId,
      })),
    })
    const replayed = await sixb.objects.upsertBatch("noop-source", batch)
    expect(newFacts()).toEqual([])
    expect(replayed.map((result) => result.ok)).toEqual([true, true, true])
    for (const result of replayed) {
      if (!result.ok) continue
      expect(result.value).toEqual(
        rowsBeforeReplay.get(objectBatchKey("noop-source", result.value.primaryId))!
      )
    }
  })

  test("repeated link upserts preserve state and emit only real changes", async () => {
    const { sixb, newFacts, listTargets } = createRuntime()
    await sixb.objects.upsert("noop-source", { id: "source-1", name: "Source" })
    await sixb.objects.upsert("noop-target", { id: "target-1" })
    await sixb.objects.upsert("noop-target", { id: "target-2" })
    const toTarget1 = { targetTypeId: "noop-target", targetId: "target-1" }
    await sixb.objects.upsertLink("noop-source", "source-1", "targets", {
      ...toTarget1,
      properties: { role: "primary" },
    })
    newFacts()
    const created = await listTargets()

    await sixb.objects.upsertLink("noop-source", "source-1", "targets", {
      ...toTarget1,
      properties: { role: "primary" },
    })
    expect(newFacts()).toEqual([])
    expect(await listTargets()).toEqual(created)

    const batch = [
      {
        objectTypeId: "noop-source",
        sourceId: "source-1",
        linkId: "targets",
        target: { ...toTarget1, properties: { role: "primary" } },
      },
      {
        objectTypeId: "noop-source",
        sourceId: "source-1",
        linkId: "targets",
        target: { targetTypeId: "noop-target", targetId: "target-2" },
      },
    ] as const
    expect((await sixb.objects.upsertLinkBatch(batch)).map((result) => result.ok)).toEqual([
      true,
      true,
    ])
    expect(newFacts()).toEqual(["link.created"])

    const linksBeforeReplay = await listTargets()
    expect((await sixb.objects.upsertLinkBatch(batch)).map((result) => result.ok)).toEqual([
      true,
      true,
    ])
    expect(newFacts()).toEqual([])
    expect(await listTargets()).toEqual(linksBeforeReplay)
  })

  test("canonicalizes decimal link properties before no-op detection and persistence", async () => {
    const { sixb, newFacts, listTargets } = createRuntime()
    await sixb.objects.upsert("noop-source", { id: "source-1", name: "Source" })
    await sixb.objects.upsert("noop-target", { id: "target-1" })
    await sixb.objects.upsert("noop-target", { id: "target-2" })
    await sixb.objects.upsertLink("noop-source", "source-1", "targets", {
      targetTypeId: "noop-target",
      targetId: "target-1",
      properties: { amount: "+001.2300" },
    })
    newFacts()

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

    expect(results.map((result) => result.ok)).toEqual([true, true])
    expect(newFacts()).toEqual(["link.created"])
    expect(
      (await listTargets())
        .map((row) => [row.targetId, row.properties?.amount])
        .sort(([left], [right]) => String(left).localeCompare(String(right)))
    ).toEqual([
      ["target-1", "1.23"],
      ["target-2", "2.5"],
    ])
  })
})
