import { expect, test } from "bun:test"
import { defineAction, defineObjectType, prop } from "../src"
import { snapshotActionDescriptor } from "../src/actions/descriptor"
import { schemaFieldsToJsonSchema } from "../src/ontology/json-schema"

test("Action metadata contains no executable handlers or live ontology definitions", () => {
  const Proposal = defineObjectType({
    id: "proposal",
    name: "Proposal",
    properties: [prop("id", "string", { primary: true })],
  })
  const approve = defineAction("approve")
    .on(Proposal)
    .params({
      reason: { schema: { type: "enum", valueType: "string", values: ["accepted", "rejected"] } },
    })
    .validate(() => {})
    .edits(() => {})
  // Returning the live definition instead of snapshotActionDescriptor makes this fail:
  // structuredClone rejects phase functions, and the binding leaks the complete ObjectType.
  const descriptor = snapshotActionDescriptor(approve)
  expect(structuredClone(descriptor)).toEqual(descriptor)
  expect(descriptor.binding).toEqual({ kind: "object", objectTypeId: "proposal" })
  expect(descriptor.phases).toEqual({
    validate: true,
    writeback: false,
    edits: true,
    effects: false,
  })
  expect(descriptor.params).not.toBe(approve.params)
  expect(Object.isFrozen(descriptor.params.reason.schema)).toBe(true)
  expect(descriptor).not.toHaveProperty("edits")
  // Requiring mutable SchemaOrRef fields in the converter makes this fail typecheck.
  // HTTP action details must still render the exact input schema from frozen metadata.
  expect(
    schemaFieldsToJsonSchema({ fields: descriptor.params, valueTypesById: new Map() })
  ).toEqual({
    type: "object",
    properties: { reason: { enum: ["accepted", "rejected"] } },
    additionalProperties: false,
  })
})
