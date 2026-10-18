import { describe, expect, test } from "bun:test"
import { defineObjectType, OntologyRegistry, prop } from "../src"
import {
  createCommitId,
  createEventId,
  createOntologyMaterializer,
  linkRefKey,
  normalizeOntologyEditCommit,
  normalizeProjectionSourceEntry,
  normalizeTelemetryAppend,
  objectRefKey,
  projectionEntityKey,
  sha256Canonical,
} from "../src/materializer"
import {
  DEFAULT_MATERIALIZATION_BATCHING,
  resolveMaterializationBatching,
} from "../src/materializer/shared/batching"
import { createMaterializerFixture } from "./materializer-fixture"

const leftObject = { objectTypeId: "a:b", primaryId: "c" }
const rightObject = { objectTypeId: "a", primaryId: "b:c" }

describe("materializer canonical contracts", () => {
  test("rejects storage without ontology capabilities at construction", () => {
    const { ontology, projections, storage } = createMaterializerFixture()
    const malformedStorage = { ...storage, ontology: undefined }

    expect(() =>
      createOntologyMaterializer({
        projectId: "project",
        ontology,
        projections,
        storage: malformedStorage as never,
      })
    ).toThrow("Storage does not provide ontology capabilities")
  })

  test("rejects an Ontology that differs from the projection registry", () => {
    const { projections, storage } = createMaterializerFixture()
    const incompatibleOntology = new OntologyRegistry({
      sources: [
        defineObjectType({
          id: "Device",
          name: "Device",
          properties: [
            prop("id", "string", { primary: true, required: true }),
            prop("name", "double", { required: true }),
          ],
        }),
      ],
    })

    expect(() =>
      createOntologyMaterializer({
        projectId: "project",
        ontology: incompatibleOntology,
        projections,
        storage,
      })
    ).toThrow("does not match the Ontology pinned by its projection registry")
  })

  test("uses unambiguous JSON-array keys for every entity kind", () => {
    expect(objectRefKey(leftObject)).toBe('["a:b","c"]')
    expect(objectRefKey(leftObject)).not.toBe(objectRefKey(rightObject))

    const link = {
      source: leftObject,
      linkId: "owns:part",
      target: rightObject,
    }
    expect(linkRefKey(link)).toBe('["a:b","c","owns:part","a","b:c"]')
    expect(projectionEntityKey({ kind: "link", ref: link })).toBe(
      '["link","a:b","c","owns:part","a","b:c"]'
    )
  })

  test("normalizes edit intent without reordering operations", () => {
    const normalized = normalizeOntologyEditCommit({
      mode: "atomic",
      source: { kind: "runtime", requestId: "request-1" },
      operations: [
        {
          id: "first",
          kind: "object.patch",
          ref: leftObject,
          set: { z: 1, a: null },
          unset: ["zeta", "beta"],
          reset: ["gamma"],
        },
        { id: "second", kind: "object.delete", ref: rightObject },
      ],
      expectedObjects: [
        { ref: rightObject, exists: false },
        { ref: rightObject, exists: false },
      ],
      expectedLinks: [],
      expectedLinkScopes: [],
    })

    expect(normalized.operations.map((operation) => operation.id)).toEqual(["first", "second"])
    const first = normalized.operations[0]
    expect(first.kind).toBe("object.patch")
    if (first.kind !== "object.patch") throw new Error("unexpected operation")
    expect(Object.keys(first.set)).toEqual(["a", "z"])
    expect(first.unset).toEqual(["beta", "zeta"])
    expect(normalized.mode === "atomic" && normalized.expectedObjects).toHaveLength(1)
  })

  test("rejects duplicate operation ids and contradictory expectations", () => {
    expect(() =>
      normalizeOntologyEditCommit({
        mode: "continue",
        source: { kind: "runtime", requestId: "request-1" },
        operations: [
          { id: "same", kind: "object.delete", ref: leftObject },
          { id: "same", kind: "object.restore", ref: leftObject },
        ],
      })
    ).toThrow("[Sixb] Duplicate operation id 'same'.")

    expect(() =>
      normalizeOntologyEditCommit({
        mode: "atomic",
        source: { kind: "runtime", requestId: "request-1" },
        operations: [],
        expectedObjects: [
          { ref: leftObject, exists: false },
          { ref: leftObject, exists: true, version: 1, lastCommitId: "commit-1" },
        ],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
    ).toThrow("contradictory")
  })

  test("accepts only explicit contiguous operation groups", () => {
    const operations = [
      { id: "first", kind: "object.delete" as const, ref: leftObject },
      { id: "second", kind: "object.restore" as const, ref: leftObject },
      { id: "third", kind: "object.delete" as const, ref: rightObject },
    ]
    const normalize = (operationGroups: readonly (readonly string[])[]) =>
      normalizeOntologyEditCommit({
        mode: "continue",
        source: { kind: "runtime", requestId: "group-contract" },
        operations,
        operationGroups,
      })

    const valid = normalize([["first", "second"]])
    expect(valid.mode === "continue" ? valid.operationGroups : undefined).toEqual([
      ["first", "second"],
    ])
    expect(() => normalize([["first"]])).toThrow("at least two")
    expect(() => normalize([["first", "missing"]])).toThrow("unknown operation id 'missing'")
    expect(() => normalize([["first", "third"]])).toThrow("contiguous run in operation order")
    expect(() => normalize([["second", "first"]])).toThrow("contiguous run in operation order")
    expect(() =>
      normalize([
        ["first", "second"],
        ["second", "third"],
      ])
    ).toThrow("appears in more than one operation group")
  })

  test("requires matching projection root assertions", () => {
    expect(() =>
      normalizeProjectionSourceEntry({
        root: { kind: "object", ref: leftObject },
        assertions: [{ kind: "object", ref: rightObject, properties: {} }],
      })
    ).toThrow("must contain an assertion matching root")

    expect(() =>
      normalizeProjectionSourceEntry({
        root: { kind: "object", ref: leftObject },
        assertions: [
          { kind: "object", ref: leftObject, properties: {} },
          { kind: "object", ref: rightObject, properties: {} },
        ],
      })
    ).toThrow("exactly its matching object assertion plus links")

    expect(() =>
      normalizeProjectionSourceEntry({
        root: { kind: "object", ref: leftObject },
        assertions: [
          { kind: "object", ref: leftObject, properties: {} },
          {
            kind: "link",
            ref: { source: rightObject, linkId: "related", target: leftObject },
          },
        ],
      })
    ).toThrow("only links sourced from that root")

    const linkRef = { source: leftObject, linkId: "related", target: rightObject }
    expect(() =>
      normalizeProjectionSourceEntry({
        root: { kind: "link", ref: linkRef },
        assertions: [
          { kind: "link", ref: linkRef },
          { kind: "object", ref: leftObject, properties: {} },
        ],
      })
    ).toThrow("exactly its matching link assertion")
  })

  test("strictly validates projection source update timestamps", () => {
    // Regression proof: replacing the strict parser with Date.parse makes Bun roll February 30
    // into March 2, so this assertion stops throwing.
    expect(() =>
      normalizeProjectionSourceEntry({
        root: { kind: "object", ref: leftObject },
        assertions: [
          {
            kind: "object",
            ref: leftObject,
            properties: {},
            sourceUpdatedAt: "2026-02-30T03:04:05Z",
          },
        ],
      })
    ).toThrow("Projection source update timestamp must be a valid timestamp")

    const normalized = normalizeProjectionSourceEntry({
      root: { kind: "object", ref: leftObject },
      assertions: [
        {
          kind: "object",
          ref: leftObject,
          properties: {},
          sourceUpdatedAt: "2026-01-02 03:04:05-05:00",
        },
      ],
    })
    expect(normalized.assertions[0]).toMatchObject({
      sourceUpdatedAt: "2026-01-02T08:04:05.000Z",
    })
  })

  test("collapses equal telemetry duplicates and rejects conflicting points", () => {
    const point = {
      series: { object: leftObject, propertyId: "temperature" },
      value: 21,
      at: "2026-01-02T03:04:05Z",
    }
    const normalized = normalizeTelemetryAppend({
      source: { kind: "runtime", requestId: "request-1" },
      points: [point, { ...point }],
    })
    expect(normalized.points).toHaveLength(1)
    expect(normalized.points[0].at).toBe("2026-01-02T03:04:05.000Z")

    expect(() =>
      normalizeTelemetryAppend({
        source: { kind: "runtime", requestId: "request-1" },
        points: [point, { ...point, value: 22 }],
      })
    ).toThrow("Conflicting telemetry points")

    const projectionAppend = normalizeTelemetryAppend({
      source: {
        kind: "projection",
        projection: { projectionId: "temperatures" },
        datasetVersion: {
          datasetId: "readings",
          versionId: "version-1",
          createdAt: "2026-01-02T03:04:05Z",
        },
        execution: { projectionRunId: "run-1", executionToken: "execution-1" },
        batchOrdinal: 2,
        sourceRowCount: 1,
        sourceRowsSkipped: 0,
        inputExhausted: true,
      },
      points: [point],
    })
    expect(
      projectionAppend.source.kind === "projection" && projectionAppend.source.batchOrdinal
    ).toBe(2)
  })

  test("derives stable SHA-256 commit and event identities", () => {
    expect(sha256Canonical({ b: 2, a: 1 })).toBe(sha256Canonical({ a: 1, b: 2 }))
    expect(sha256Canonical({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
    expect(() => sha256Canonical({ invalid: undefined })).toThrow(
      "Canonical hash input must be a JSON value; Canonical hash input.invalid is undefined"
    )
    expect(() => sha256Canonical(new Date())).toThrow("Canonical hash input must be a JSON value")
    expect(createCommitId("project", "runtime:request")).toBe(
      createCommitId("project", "runtime:request")
    )
    expect(createEventId("project", "commit", 1)).not.toBe(createEventId("project", "commit", 2))
  })

  test("keeps bounded batching under the hood", () => {
    expect(resolveMaterializationBatching()).toEqual(DEFAULT_MATERIALIZATION_BATCHING)
    expect(resolveMaterializationBatching({ statePageRows: 2 }).statePageRows).toBe(2)
    expect(() => resolveMaterializationBatching({ planChunkRows: 0 })).toThrow(
      "must be a positive safe integer"
    )
  })
})
