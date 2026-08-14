import { describe, expect, test } from "bun:test"
import type { JsonValue } from "../src/json"
import type {
  EditCommitResult,
  EffectiveLinkChange,
  EffectiveObjectChange,
  LinkOverride,
  LinkSlotOverride,
  ObjectOverride,
  OntologyEditOperation,
} from "../src/materializer"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import { atomic, createMaterializerFixture, replacement, sourceEntry } from "./materializer-fixture"

type Override = { kind: "patch"; name: string } | { kind: "delete" }

describe("ontology materializer reference sequence", () => {
  test("matches a small edits-win reference model after every deterministic transition", async () => {
    const { materializer, storage } = createMaterializerFixture({
      dependencies: {
        batching: {
          sourceStageRows: 1,
          statePageRows: 1,
          planChunkRows: 1,
          planChunkBytes: 1,
        },
      },
    })
    const source = new Map<string, string>()
    const overrides = new Map<string, Override>()

    const expected = () =>
      new Map(
        [...source.entries()]
          .filter(([id]) => overrides.get(id)?.kind !== "delete")
          .map(([id, name]) => {
            const override = overrides.get(id)
            return [id, override?.kind === "patch" ? override.name : name] as const
          })
      )
    const compare = async () => {
      const rows = await storage.objects.list({
        projectId: "project",
        objectTypeId: "Device",
        orderBy: "primaryId",
        order: "asc",
      })
      expect(
        new Map(rows.objects.map((row) => [row.primaryId, row.properties.name as string]))
      ).toEqual(expected())
    }

    source.set("a", "source-a")
    source.set("b", "source-b")
    await materializer.projections.replace(
      replacement("v1", "2026-01-01T00:00:00Z", [
        sourceEntry("a", "source-a"),
        sourceEntry("b", "source-b"),
      ])
    )
    await compare()

    overrides.set("a", { kind: "patch", name: "edited-a" })
    await materializer.edits.commit(
      atomic("patch-a", [
        {
          id: "patch",
          kind: "object.patch",
          ref: { objectTypeId: "Device", primaryId: "a" },
          set: { name: "edited-a" },
          unset: [],
          reset: [],
        },
      ])
    )
    await compare()

    source.clear()
    source.set("b", "source-b-2")
    source.set("c", "source-c")
    await materializer.projections.replace(
      replacement("v2", "2026-01-02T00:00:00Z", [
        sourceEntry("b", "source-b-2"),
        sourceEntry("c", "source-c"),
      ])
    )
    await compare()

    source.clear()
    source.set("a", "source-a-returned")
    source.set("c", "source-c")
    await materializer.projections.replace(
      replacement("v3", "2026-01-03T00:00:00Z", [
        sourceEntry("a", "source-a-returned"),
        sourceEntry("c", "source-c"),
      ])
    )
    await compare()

    overrides.set("a", { kind: "delete" })
    await materializer.edits.commit(
      atomic("delete-a", [
        {
          id: "delete",
          kind: "object.delete",
          ref: { objectTypeId: "Device", primaryId: "a" },
        },
      ])
    )
    await compare()

    overrides.delete("a")
    await materializer.edits.commit(
      atomic("restore-a", [
        {
          id: "restore",
          kind: "object.restore",
          ref: { objectTypeId: "Device", primaryId: "a" },
        },
      ])
    )
    await compare()
  })

  test("matches bounded deterministic generated object/link/telemetry sequences", async () => {
    for (const seed of [7, 19, 43]) await runGeneratedSequence(seed)
  })
})

async function runGeneratedSequence(seed: number): Promise<void> {
  const random = mulberry32(seed)
  const { materializer, storage } = createMaterializerFixture({
    dependencies: {
      batching: {
        sourceStageRows: 2,
        statePageRows: 2,
        planChunkRows: 2,
        planChunkBytes: 256,
      },
    },
  })
  const sourceObjects = new Map<string, ModelProperties>()
  const sourceLinks = new Set<string>()
  const objectOverrides = new Map<string, ObjectOverride>()
  const linkOverrides = new Map<string, LinkOverride>()
  const linkSlotOverrides = new Map<string, LinkSlotOverride>()
  const latest = new Map<string, { at: string; value: number }>()
  const objectRevisions = new Map<string, { version: number; lastCommitId: string }>()
  const linkRevisions = new Map<string, string>()
  const expectedEventsByCommit = new Map<string, number>()
  let request = 0

  const word = (prefix: string) => `${prefix}-${seed}-${Math.floor(random() * 1_000_000)}`
  const objectRef = (primaryId: string) => ({ objectTypeId: "Device", primaryId })
  const linkRef = (linkId: string, sourceId: string, targetId: string) => ({
    source: objectRef(sourceId),
    linkId,
    target: objectRef(targetId),
  })
  const linkKey = (linkId: string, sourceId: string, targetId: string) =>
    JSON.stringify([sourceId, linkId, targetId])
  const linkScopeKey = (linkId: string, sourceId: string) => JSON.stringify([sourceId, linkId])

  const resolveObjects = (): Map<string, ModelProperties> => {
    const ids = new Set([...sourceObjects.keys(), ...objectOverrides.keys()])
    const resolved = new Map<string, ModelProperties>()
    for (const id of ids) {
      const source = sourceObjects.get(id)
      const override = objectOverrides.get(id)
      let properties: ModelProperties | null = null
      if (override?.kind === "delete") continue
      if (override?.kind === "create") properties = { ...override.properties }
      else if (source) {
        properties = { ...source }
        if (override?.kind === "patch") {
          for (const propertyId of override.unset) delete properties[propertyId]
          Object.assign(properties, override.set)
        }
      }
      if (!properties) continue
      properties.id = id
      const point = latest.get(id)
      if (point) properties.temperature = point.value
      resolved.set(id, properties)
    }
    return resolved
  }

  const resolveLinks = (objects = resolveObjects()): Map<string, ModelLink> => {
    const keys = new Set([...sourceLinks, ...linkOverrides.keys()])
    const resolved = new Map<string, ModelLink>()
    for (const key of keys) {
      const [sourceId, linkId, targetId] = JSON.parse(key) as string[]
      if (linkId === "parent") continue
      if (!objects.has(sourceId) || !objects.has(targetId)) continue
      const override = linkOverrides.get(key)
      if (override?.kind === "delete") continue
      if (override?.kind !== "upsert" && !sourceLinks.has(key)) continue
      resolved.set(key, { sourceId, linkId, targetId })
    }
    const sourceTargets = new Map<string, string>()
    for (const key of sourceLinks) {
      const [sourceId, linkId, targetId] = JSON.parse(key) as string[]
      if (linkId === "parent") sourceTargets.set(linkScopeKey(linkId, sourceId), targetId!)
    }
    const scopes = new Set([...sourceTargets.keys(), ...linkSlotOverrides.keys()])
    for (const scope of scopes) {
      const [sourceId, linkId] = JSON.parse(scope) as string[]
      const override = linkSlotOverrides.get(scope)
      if (override?.kind === "clear") continue
      const targetId =
        override?.kind === "set" ? override.target.primaryId : sourceTargets.get(scope)
      if (!targetId || !objects.has(sourceId!) || !objects.has(targetId)) continue
      const key = linkKey(linkId!, sourceId!, targetId)
      resolved.set(key, { sourceId: sourceId!, linkId: linkId!, targetId })
    }
    return resolved
  }

  const compareState = async () => {
    const expectedObjects = resolveObjects()
    const actualObjects = await storage.objects.list({
      projectId: "project",
      objectTypeId: "Device",
      orderBy: "primaryId",
      order: "asc",
    })
    expect(actualObjects.objects.map((row) => row.primaryId)).toEqual(
      [...expectedObjects.keys()].sort()
    )
    for (const row of actualObjects.objects) {
      const expected = expectedObjects.get(row.primaryId)
      const revision = objectRevisions.get(row.primaryId)
      if (!expected || !revision) throw new Error("reference-model object state is incomplete")
      expect(row.properties).toEqual(expected)
      expect({ version: row.version, lastCommitId: row.lastCommitId }).toEqual(revision)
    }

    const expectedLinks = resolveLinks(expectedObjects)
    const actualLinks = actualObjects.objects.flatMap((row) =>
      storage.objects.listLinks({
        projectId: "project",
        objectTypeId: "Device",
        objectId: row.primaryId,
      })
    )
    const rows = (await Promise.all(actualLinks)).flat()
    const canonicalRows = new Map(
      rows.map((row) => [
        linkKey(row.linkId, row.sourceId, row.targetId),
        { sourceId: row.sourceId, linkId: row.linkId, targetId: row.targetId },
      ])
    )
    expect(canonicalRows).toEqual(expectedLinks)
    for (const row of rows) {
      const revision = linkRevisions.get(linkKey(row.linkId, row.sourceId, row.targetId))
      if (!revision) throw new Error("Expected every materialized link to have a revision.")
      expect(row.lastCommitId).toBe(revision)
    }

    const snapshot = getInMemoryOntologyStorageTestingAdapter(storage.ontology).snapshot()
    expect(
      new Map(
        [...snapshot.objectOverrides.values()]
          .filter((value) => value.projectId === "project")
          .map((value) => [value.ref.primaryId, value.value])
      )
    ).toEqual(objectOverrides)
    expect(
      new Map(
        [...snapshot.linkOverrides.values()]
          .filter((value) => value.projectId === "project")
          .map((value) => [
            linkKey(value.ref.linkId, value.ref.source.primaryId, value.ref.target.primaryId),
            value.value,
          ])
      )
    ).toEqual(linkOverrides)
    expect(
      new Map(
        [...snapshot.linkSlotOverrides.values()]
          .filter((value) => value.projectId === "project")
          .map((value) => [linkScopeKey(value.ref.linkId, value.ref.source.primaryId), value.value])
      )
    ).toEqual(linkSlotOverrides)
  }

  const applyEffectiveTransition = (
    beforeObjects: Map<string, ModelProperties>,
    beforeLinks: Map<string, ModelLink>,
    commitId: string,
    eventCount: number,
    changes?: EditCommitResult["changes"]
  ) => {
    const afterObjects = resolveObjects()
    const afterLinks = resolveLinks(afterObjects)
    const objectDiffs = diffMaps(beforeObjects, afterObjects)
    const linkDiffs = diffMaps(beforeLinks, afterLinks)
    expect(eventCount).toBe(objectDiffs.length + linkDiffs.length)
    expectedEventsByCommit.set(commitId, eventCount)
    if (changes) {
      expect(changes.objects.map(changeIdentity)).toEqual(
        objectDiffs.map((change) => `${change.kind}:object:${change.key}`)
      )
      expect(changes.links.map(changeIdentity)).toEqual(
        linkDiffs.map((change) => `${change.kind}:link:${change.key}`)
      )
    }
    for (const change of objectDiffs) {
      if (change.kind === "deleted") objectRevisions.delete(change.key)
      else {
        objectRevisions.set(change.key, {
          version:
            change.kind === "created" ? 1 : (objectRevisions.get(change.key)?.version ?? 0) + 1,
          lastCommitId: commitId,
        })
      }
    }
    for (const change of linkDiffs) {
      if (change.kind === "deleted") linkRevisions.delete(change.key)
      else linkRevisions.set(change.key, commitId)
    }
  }

  const commitEdit = async (operation: OntologyEditOperation, update: () => void) => {
    const beforeObjects = resolveObjects()
    const beforeLinks = resolveLinks(beforeObjects)
    const result = await materializer.edits.commit(
      atomic(`model-${seed}-${++request}`, [operation])
    )
    update()
    applyEffectiveTransition(
      beforeObjects,
      beforeLinks,
      result.commitId,
      result.eventCount,
      result.changes
    )
    await compareState()
  }

  const replaceSource = async (
    version: string,
    objects: Map<string, ModelProperties>,
    parents: Map<string, string>
  ) => {
    const beforeObjects = resolveObjects()
    const beforeLinks = resolveLinks(beforeObjects)
    const result = await materializer.projections.replace(
      replacement(
        `${seed}-${version}`,
        `2026-01-${String(++request).padStart(2, "0")}T00:00:00Z`,
        [...objects.entries()].map(([id, properties]) => {
          const parentId = parents.get(id)
          const object = sourceEntry(
            id,
            String(properties.name),
            properties.note as string | null | undefined
          )
          return parentId
            ? {
                ...object,
                assertions: [
                  ...object.assertions,
                  { kind: "link" as const, ref: linkRef("parent", id, parentId) },
                ],
              }
            : object
        })
      )
    )
    sourceObjects.clear()
    for (const [id, properties] of objects) sourceObjects.set(id, { ...properties })
    sourceLinks.clear()
    for (const [sourceId, targetId] of parents)
      sourceLinks.add(linkKey("parent", sourceId, targetId))
    applyEffectiveTransition(beforeObjects, beforeLinks, result.commitId, result.eventCount)
    await compareState()
  }

  const initialObjects = new Map<string, ModelProperties>([
    ["a", { name: word("a"), note: word("note-a") }],
    ["b", { name: word("b"), note: word("note-b") }],
    ["c", { name: word("c") }],
  ])
  await replaceSource("initial", initialObjects, new Map([["a", "b"]]))

  const patchedNote = word("patched")
  await commitEdit(
    {
      id: "patch-set",
      kind: "object.patch",
      ref: objectRef("a"),
      set: { note: patchedNote },
      unset: [],
      reset: [],
    },
    () => objectOverrides.set("a", { kind: "patch", set: { note: patchedNote }, unset: [] })
  )
  await commitEdit(
    {
      id: "patch-unset",
      kind: "object.patch",
      ref: objectRef("a"),
      set: {},
      unset: ["note"],
      reset: [],
    },
    () => objectOverrides.set("a", { kind: "patch", set: {}, unset: ["note"] })
  )
  await commitEdit(
    {
      id: "patch-reset",
      kind: "object.patch",
      ref: objectRef("a"),
      set: {},
      unset: [],
      reset: ["note"],
    },
    () => objectOverrides.delete("a")
  )

  const bOverrideName = word("b-upsert")
  await commitEdit(
    {
      id: "upsert-source",
      kind: "object.upsert",
      ref: objectRef("b"),
      properties: { name: bOverrideName },
    },
    () => objectOverrides.set("b", { kind: "patch", set: { name: bOverrideName }, unset: [] })
  )
  await commitEdit({ id: "delete-source", kind: "object.delete", ref: objectRef("c") }, () =>
    objectOverrides.set("c", { kind: "delete" })
  )
  await commitEdit({ id: "restore-source", kind: "object.restore", ref: objectRef("c") }, () =>
    objectOverrides.delete("c")
  )

  const independentName = word("independent")
  const independentNote = word("x-note")
  await commitEdit(
    {
      id: "create",
      kind: "object.create",
      ref: objectRef("x"),
      properties: { name: independentName, note: independentNote },
    },
    () =>
      objectOverrides.set("x", {
        kind: "create",
        properties: { name: independentName, note: independentNote },
      })
  )
  await commitEdit(
    {
      id: "patch-create",
      kind: "object.patch",
      ref: objectRef("x"),
      set: {},
      unset: ["note"],
      reset: [],
    },
    () => objectOverrides.set("x", { kind: "create", properties: { name: independentName } })
  )
  await commitEdit({ id: "delete-create", kind: "object.delete", ref: objectRef("x") }, () =>
    objectOverrides.delete("x")
  )
  const recreatedName = word("recreated")
  await commitEdit(
    {
      id: "upsert-absent",
      kind: "object.upsert",
      ref: objectRef("x"),
      properties: { name: recreatedName },
    },
    () => objectOverrides.set("x", { kind: "create", properties: { name: recreatedName } })
  )

  const peersKey = linkKey("peers", "a", "c")
  await commitEdit(
    { id: "link-upsert", kind: "link.upsert", ref: linkRef("peers", "a", "c") },
    () => linkOverrides.set(peersKey, { kind: "upsert" })
  )
  await commitEdit(
    { id: "link-delete", kind: "link.delete", ref: linkRef("peers", "a", "c") },
    () => linkOverrides.delete(peersKey)
  )
  await commitEdit(
    { id: "link-upsert-again", kind: "link.upsert", ref: linkRef("peers", "a", "c") },
    () => linkOverrides.set(peersKey, { kind: "upsert" })
  )
  await commitEdit({ id: "link-reset", kind: "link.reset", ref: linkRef("peers", "a", "c") }, () =>
    linkOverrides.delete(peersKey)
  )

  const parentScope = linkScopeKey("parent", "a")
  await commitEdit(
    { id: "source-link-delete", kind: "link.delete", ref: linkRef("parent", "a", "b") },
    () => linkSlotOverrides.set(parentScope, { kind: "clear", target: objectRef("b") })
  )
  await commitEdit(
    { id: "source-link-reset", kind: "link.reset", ref: linkRef("parent", "a", "b") },
    () => linkSlotOverrides.delete(parentScope)
  )

  const nextObjects = new Map<string, ModelProperties>([
    ["a", { name: word("a-next"), note: word("a-next-note") }],
    ["c", { name: word("c-next") }],
  ])
  await replaceSource("withdraw-b", nextObjects, new Map([["a", "c"]]))
  const promotedName = word("b-promoted")
  await commitEdit(
    {
      id: "promote-dormant-patch",
      kind: "object.upsert",
      ref: objectRef("b"),
      properties: { name: promotedName },
    },
    () => objectOverrides.set("b", { kind: "create", properties: { name: promotedName } })
  )

  const beforeConflict = getInMemoryOntologyStorageTestingAdapter(storage.ontology).snapshot()
  await expect(
    materializer.edits.commit(
      atomic(`model-${seed}-cardinality-conflict`, [
        {
          id: "cardinality-conflict",
          kind: "link.upsert",
          ref: linkRef("parent", "a", "b"),
        },
      ])
    )
  ).rejects.toThrow("cardinality one")
  expect(getInMemoryOntologyStorageTestingAdapter(storage.ontology).snapshot()).toEqual(
    beforeConflict
  )
  await compareState()

  const appendPoint = async (requestId: string, at: string, value: number) => {
    const beforeObjects = resolveObjects()
    const beforeLinks = resolveLinks(beforeObjects)
    const result = await materializer.telemetry.append({
      source: { kind: "runtime", requestId },
      points: [{ series: { object: objectRef("a"), propertyId: "temperature" }, at, value }],
    })
    const prior = latest.get("a")
    if (!prior || at > prior.at) latest.set("a", { at, value })
    const afterObjects = resolveObjects()
    const objectDiffs = diffMaps(beforeObjects, afterObjects)
    const linkDiffs = diffMaps(beforeLinks, resolveLinks(afterObjects))
    expect(result.eventCount).toBe(1 + objectDiffs.length + linkDiffs.length)
    expectedEventsByCommit.set(result.commitId, result.eventCount)
    for (const change of objectDiffs) {
      objectRevisions.set(change.key, {
        version: (objectRevisions.get(change.key)?.version ?? 0) + 1,
        lastCommitId: result.commitId,
      })
    }
    expect(result.latestObjectsChanged).toBe(objectDiffs.length)
    await compareState()
  }
  await appendPoint(`model-${seed}-latest`, "2026-02-02T00:00:00.000Z", seed + 0.5)
  await appendPoint(`model-${seed}-older`, "2026-02-01T00:00:00.000Z", seed - 0.5)

  const outbox = await storage.ontology.outbox.claim({
    projectId: "project",
    now: "2027-01-01T00:00:00.000Z",
    limit: 1_000,
    leaseId: `model-${seed}`,
    leaseExpiresAt: "2027-01-01T01:00:00.000Z",
  })
  const actualEventsByCommit = new Map<string, number>()
  for (const row of outbox) {
    actualEventsByCommit.set(
      row.envelope.commitId,
      (actualEventsByCommit.get(row.envelope.commitId) ?? 0) + 1
    )
  }
  expect(actualEventsByCommit).toEqual(expectedEventsByCommit)
}

type ModelProperties = Record<string, JsonValue>
interface ModelLink {
  readonly sourceId: string
  readonly linkId: string
  readonly targetId: string
}

function diffMaps<T>(before: Map<string, T>, after: Map<string, T>) {
  const changes: { key: string; kind: "created" | "updated" | "deleted" }[] = []
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const left = before.get(key)
    const right = after.get(key)
    if (left === undefined && right !== undefined) changes.push({ key, kind: "created" })
    else if (left !== undefined && right === undefined) changes.push({ key, kind: "deleted" })
    else if (JSON.stringify(left) !== JSON.stringify(right)) changes.push({ key, kind: "updated" })
  }
  return changes
}

function changeIdentity(change: EffectiveObjectChange | EffectiveLinkChange): string {
  const snapshot = change.after ?? change.before
  if (!snapshot) throw new Error("reference-model change lacks a snapshot")
  if ("primaryId" in snapshot.ref) return `${change.kind}:object:${snapshot.ref.primaryId}`
  return `${change.kind}:link:${JSON.stringify([
    snapshot.ref.source.primaryId,
    snapshot.ref.linkId,
    snapshot.ref.target.primaryId,
  ])}`
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}
