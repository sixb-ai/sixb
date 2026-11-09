import { describe, expect, test } from "bun:test"
import {
  artifactRef,
  col,
  defineDataset,
  defineObjectType,
  defineProjection,
  defineValueType,
  link,
  OntologyRegistry,
  prop,
  ref,
  valueTypeRef,
} from "../src"
import { ProjectionRegistry } from "../src/materializer"
import { validateObjectQuery } from "../src/objects/query"
import { isArtifactRef } from "../src/ontology/artifact-ref"
import { schemaRecordToJsonSchema } from "../src/ontology/json-schema"
import { resolvePropertyQueryCapabilities } from "../src/ontology/query-capabilities"
import { normalizeSchemaValue, validateSchemaValue } from "../src/ontology/validation"

const Section = defineValueType({
  id: "Section",
  name: "Section",
  schema: { type: "object", properties: { doc: { schema: ref.artifact() } } },
})

const Meeting = defineObjectType({
  id: "Meeting",
  name: "Meeting",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("title", "string"),
    prop("kickoffDoc", ref.artifact(), {
      nullable: true,
      query: { searchable: true, filterable: true },
    }),
    prop("attachments", { type: "array", items: ref.artifact() }),
    prop("sections", { type: "map", keySchema: "string", valueSchema: valueTypeRef(Section) }),
  ],
})

const valueTypesById = new Map()

describe("ref.artifact()", () => {
  test("serializes as artifactRef, valued { type: 'artifact', id }", () => {
    expect(ref.artifact()).toBe("artifactRef")
    expect(artifactRef("art_k3m9q2x7tp")).toEqual({ type: "artifact", id: "art_k3m9q2x7tp" })
    expect(Object.isFrozen(artifactRef("art_k3m9q2x7tp"))).toBe(true)

    for (const id of ["", "k3m9q2x7tp", "art_short", "art_K3M9Q2X7TP", "art_k3m9q2x7tpx"]) {
      expect(() => artifactRef(id)).toThrow(
        "[Sixb] Artifact reference id must be an artifact id such as 'art_k3m9q2x7tp'"
      )
    }
  })

  test("accepts exactly { type: 'artifact', id } and stores it in canonical field order", () => {
    validateSchemaValue("artifactRef", artifactRef("art_k3m9q2x7tp"), "Meeting.doc", valueTypesById)

    for (const invalid of [
      "art_k3m9q2x7tp",
      { type: "user", id: "art_k3m9q2x7tp" },
      { type: "artifact", id: "art_short" },
      { type: "artifact", id: "art_k3m9q2x7tp", title: "Spoofed" },
    ]) {
      expect(isArtifactRef(invalid)).toBe(false)
      expect(() =>
        validateSchemaValue("artifactRef", invalid, "Meeting.doc", valueTypesById)
      ).toThrow(
        '[Sixb] Property Meeting.doc must be an artifact reference { type: "artifact", id }'
      )
    }

    const normalized = normalizeSchemaValue(
      "artifactRef",
      { id: "art_k3m9q2x7tp", type: "artifact" },
      "Meeting.doc",
      valueTypesById
    )
    expect(normalized).toEqual({ type: "artifact", id: "art_k3m9q2x7tp" })
    expect(Object.keys(normalized as object)).toEqual(["type", "id"])
  })

  test("describes the value shape to models", () => {
    const output = schemaRecordToJsonSchema({ shape: { doc: "artifactRef" }, valueTypesById })
    expect(output.properties).toEqual({
      doc: {
        type: "object",
        description:
          'A Sixb artifact, written {"type":"artifact","id":"<artifact-id>"}, such as "art_k3m9q2x7tp".',
        properties: {
          type: { type: "string", enum: ["artifact"] },
          id: { type: "string", pattern: "^art_[0-9a-z]{10}$" },
        },
        required: ["type", "id"],
        additionalProperties: false,
      },
    })
  })
})

describe("artifactRef queries", () => {
  const ontology = new OntologyRegistry({ sources: [Meeting] })

  test("match by identity only: no order, facet, text or substring", () => {
    const kickoffDoc = Meeting.properties[2]
    expect(resolvePropertyQueryCapabilities(kickoffDoc, valueTypesById)).toEqual({
      operators: ["eq", "neq", "in", "exists"],
      sortable: false,
      facet: false,
      text: false,
    })

    const validated = validateObjectQuery(
      {
        kind: "filter",
        predicate: { op: "eq", propertyId: "kickoffDoc", value: artifactRef("art_k3m9q2x7tp") },
        input: { kind: "start", objectTypeId: "Meeting" },
      },
      { ontology }
    )
    expect(validated.query).toMatchObject({ predicate: { scalarKind: "artifactRef" } })

    expect(() =>
      validateObjectQuery(
        {
          kind: "filter",
          predicate: { op: "lt", propertyId: "kickoffDoc", value: artifactRef("art_k3m9q2x7tp") },
          input: { kind: "start", objectTypeId: "Meeting" },
        },
        { ontology }
      )
    ).toThrow("Predicate 'lt' cannot be used with property 'kickoffDoc' on 'Meeting'")
  })
})

describe("artifactRef registration", () => {
  const define = (property: ReturnType<typeof prop>) =>
    defineObjectType({
      id: "Holder",
      name: "Holder",
      properties: [prop("id", "string", { primary: true, required: true }), property],
    })

  // Guard: the `facet`, `telemetry` and `unique` traits of `artifactRef` in
  // `ontology/primitives.ts`; turning one on lets its definition register.
  test("keeps artifact references out of facets, telemetry and unique values", () => {
    const registered = (property: ReturnType<typeof prop>) => () =>
      new OntologyRegistry({ sources: [define(property)] })

    expect(
      registered(prop("doc", ref.artifact(), { query: { searchable: true, facet: true } }))
    ).toThrow("facet")
    expect(registered(prop("doc", ref.artifact(), { mode: "telemetry" }))).toThrow(
      "[Sixb] Telemetry property 'doc' on 'Holder' cannot use artifactRef"
    )
    expect(registered(prop("doc", ref.artifact(), { unique: true }))).toThrow(
      "[Sixb] Unique property 'Holder.doc' cannot use artifactRef."
    )
  })

  // Guard: the artifactRef check on link properties in `ontology/validation/properties.ts`.
  test("rejects artifact references on link properties, even nested", () => {
    const Linked = defineObjectType({
      id: "Linked",
      name: "Linked",
      properties: [prop("id", "string", { primary: true, required: true })],
      links: [
        link("meetings", Meeting, {
          properties: [prop("notes", { type: "array", items: ref.artifact() })],
        }),
      ],
    })

    expect(() => new OntologyRegistry({ sources: [Meeting, Linked] })).toThrow(
      "[Sixb] Link property 'Linked.meetings.notes' cannot use ref.artifact(). Artifact references are supported on object properties only."
    )
  })

  // Guard: the artifactRef check in `projections/validation.ts`; without it this mapping registers.
  test("rejects projections that map an artifact reference, even nested in JSON", () => {
    const meetings = defineDataset("meetings", {
      schema: [col("meeting_id", "string"), col("sections", "json")],
    })
    const projection = {
      _tag: "ObjectProjectionDefinition" as const,
      id: "meetings",
      objectTypeId: "Meeting",
      datasetId: "meetings",
      properties: { id: "meeting_id", sections: "sections" },
      links: {},
    }

    expect(
      () =>
        new ProjectionRegistry({
          projections: [projection],
          ontology: new OntologyRegistry({ sources: [Meeting] }),
          datasetsById: new Map([[meetings.id, meetings]]),
        })
    ).toThrow(
      '[Sixb] Projection "meetings": property "Meeting.sections" holds artifact references (ref.artifact()), which a dataset column cannot hold. Set it from an Action or a runtime edit.'
    )

    // Authoring the same mapping does not type-check either.
    defineProjection("typed-meetings", Meeting)
      .fromDataset(meetings)
      // @ts-expect-error artifact references cannot be mapped from a dataset column
      .properties({ id: "meeting_id", sections: "sections" })
  })
})
