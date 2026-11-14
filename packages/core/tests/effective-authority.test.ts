import { describe, expect, test } from "bun:test"
import type { ObjectOverride } from "../src/materialization/model"
import {
  type EffectiveObjectInput,
  explainEffectiveObject,
  type ObjectExistenceAuthority,
  type PropertyAuthority,
  resolveEffectiveObject,
} from "../src/materializer/effective/resolve"
import type { StoredSourceObjectAssertion, StoredTelemetryPoint } from "../src/storage/ontology"

const ref = { objectTypeId: "Device", primaryId: "one" }
const SOURCE_AT = "2026-01-01T00:00:10.000Z"
const EARLIER = "2026-01-01T00:00:05.000Z"
const LATER = "2026-01-01T00:00:15.000Z"

function source(
  properties: Record<string, string>,
  sourceUpdatedAt?: string
): StoredSourceObjectAssertion {
  return {
    source: { projectionId: "devices" },
    materializationId: "materialization-1",
    root: { kind: "object", ref },
    assertion: {
      kind: "object",
      ref,
      properties,
      ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
    },
    stagingOrdinal: 0,
  }
}

const reading: StoredTelemetryPoint = {
  series: { object: ref, propertyId: "temperature" },
  value: 21.5,
  at: SOURCE_AT,
  lastCommitId: "commit-reading",
}

function input(
  overrides: Partial<Omit<EffectiveObjectInput, "ref" | "primaryPropertyId">>
): EffectiveObjectInput {
  return {
    ref,
    primaryPropertyId: "id",
    source: null,
    override: null,
    editedAt: {},
    latestTelemetry: [],
    ...overrides,
  }
}

/** An object, what should make it exist, and what should decide each of its properties. */
type Explanation = [
  string,
  EffectiveObjectInput,
  ObjectExistenceAuthority,
  Record<string, PropertyAuthority>,
]

const rename: ObjectOverride = { kind: "patch", set: { name: "Edited" }, unset: [] }
const clearNote: ObjectOverride = { kind: "patch", set: {}, unset: ["note"] }

describe("explainEffectiveObject", () => {
  test.each<Explanation>([
    [
      "a source row alone",
      input({ source: source({ name: "One" }) }),
      "source",
      { name: { kind: "source" }, id: { kind: "identity" } },
    ],
    [
      "an edit over the source, editsWin",
      input({ source: source({ name: "One" }), override: rename, editedAt: { name: LATER } }),
      "source",
      {
        name: {
          kind: "edit",
          editedAt: LATER,
          wonOver: {
            candidate: { present: true, value: "One" },
            sourceUpdatedAt: undefined,
          },
        },
        id: { kind: "identity" },
      },
    ],
    [
      "a newer edit, mostRecent",
      input({
        source: source({ name: "One" }, SOURCE_AT),
        override: rename,
        editedAt: { name: LATER },
      }),
      "source",
      {
        name: {
          kind: "edit",
          editedAt: LATER,
          wonOver: { candidate: { present: true, value: "One" }, sourceUpdatedAt: SOURCE_AT },
        },
        id: { kind: "identity" },
      },
    ],
    [
      "a newer source row, mostRecent",
      input({
        source: source({ name: "One" }, SOURCE_AT),
        override: rename,
        editedAt: { name: EARLIER },
      }),
      "source",
      {
        name: {
          kind: "source",
          wonOver: {
            candidate: { present: true, value: "Edited" },
            editedAt: EARLIER,
            sourceUpdatedAt: SOURCE_AT,
          },
        },
        id: { kind: "identity" },
      },
    ],
    [
      "an edit that clears a property",
      input({
        source: source({ name: "One", note: "Old" }),
        override: clearNote,
        editedAt: { note: LATER },
      }),
      "source",
      {
        name: { kind: "source" },
        note: {
          kind: "edit",
          editedAt: LATER,
          wonOver: {
            candidate: { present: true, value: "Old" },
            sourceUpdatedAt: undefined,
          },
        },
        id: { kind: "identity" },
      },
    ],
    [
      "an object an edit created",
      input({
        override: { kind: "create", properties: { id: "one", name: "Created" } },
        editedAt: { id: EARLIER, name: EARLIER },
      }),
      "create",
      { id: { kind: "identity" }, name: { kind: "edit", editedAt: EARLIER } },
    ],
    [
      "the latest telemetry point",
      input({ source: source({ name: "One" }), latestTelemetry: [reading] }),
      "source",
      {
        name: { kind: "source" },
        id: { kind: "identity" },
        temperature: { kind: "telemetry", point: reading },
      },
    ],
  ])("records %s", (_, object, existence, properties) => {
    const explained = explainEffectiveObject(object)

    expect(explained?.value).toEqual(resolveEffectiveObject(object)!)
    expect(explained?.existence).toBe(existence)
    expect(Object.fromEntries(explained?.properties ?? [])).toEqual(properties)
  })

  test.each([
    ["a deleted object", input({ source: source({ name: "One" }), override: { kind: "delete" } })],
    ["a patch without a source row", input({ override: rename, editedAt: { name: LATER } })],
  ])("resolves %s to nothing, as resolveEffectiveObject does", (_, object) => {
    expect(resolveEffectiveObject(object)).toBeNull()
    expect(explainEffectiveObject(object)).toBeNull()
  })
})
