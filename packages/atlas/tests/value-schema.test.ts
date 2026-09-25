import { describe, expect, test } from "bun:test"
import type { FileRef } from "@sixb/core/blob-storage"
import { type WorkflowNode, workflowNodeIoSchemas } from "../src/features/workflows/utils/workflows"
import {
  childValueSchema,
  collectValueTypeSchemas,
  describeValueSchema,
  fieldRecordSchema,
  fileRefAt,
  objectRefAt,
  ontologySchemas,
  userRefAt,
  valueSchema,
} from "../src/lib/valueSchema"

const fileRef: FileRef = {
  blobId: "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sizeBytes: 7789,
  fileName: "download.jpeg",
  mediaType: "image/jpeg",
}

const kindOf = (schema: unknown, valueTypes?: ReadonlyMap<string, unknown>) =>
  describeValueSchema(valueSchema(schema, valueTypes)).kind

describe("describeValueSchema", () => {
  test("describes primitives, enums, refs, and containers", () => {
    expect(kindOf("string")).toBe("string")
    expect(kindOf("timestamp")).toBe("timestamp")
    expect(kindOf("fileRef")).toBe("fileRef")
    expect(kindOf("userRef")).toBe("userRef")
    expect(kindOf({ type: "enum", valueType: "string", values: ["a"] })).toBe("enum")
    expect(describeValueSchema(valueSchema({ type: "objectRef", objectTypeId: "Room" }))).toEqual({
      kind: "objectRef",
      objectTypeId: "Room",
    })
    expect(kindOf({ type: "object", properties: {} })).toBe("object")
    expect(kindOf({ type: "array", items: "string" })).toBe("array")
    expect(kindOf({ type: "map", keySchema: "string", valueSchema: "double" })).toBe("map")
  })

  test("describes what Atlas cannot read as unknown, never as a guess", () => {
    expect(kindOf(undefined)).toBe("unknown")
    expect(kindOf("geoPoint")).toBe("unknown")
    expect(kindOf({ type: "somethingNew" })).toBe("unknown")
    expect(kindOf({ type: "valueTypeRef", valueTypeId: "NotLoaded" })).toBe("unknown")
  })

  test("follows value type refs inline or through the collected registry", () => {
    expect(kindOf({ type: "valueTypeRef", valueTypeId: "Doc", _resolved: "fileRef" })).toBe(
      "fileRef"
    )
    const valueTypes = new Map<string, unknown>([
      ["Doc", { type: "valueTypeRef", valueTypeId: "Attachment" }],
      ["Attachment", "fileRef"],
    ])
    expect(kindOf({ type: "valueTypeRef", valueTypeId: "Doc" }, valueTypes)).toBe("fileRef")
  })

  test("stops on a value type that refers to itself", () => {
    const valueTypes = new Map<string, unknown>([
      ["Loop", { type: "valueTypeRef", valueTypeId: "Loop" }],
    ])
    expect(kindOf({ type: "valueTypeRef", valueTypeId: "Loop" }, valueTypes)).toBe("unknown")
  })

  test("resolves recursive value types lazily, one level per descent", () => {
    const tree = {
      type: "object",
      properties: {
        label: { schema: "string" },
        children: {
          schema: { type: "array", items: { type: "valueTypeRef", valueTypeId: "Tree" } },
        },
      },
    }
    const valueTypes = new Map<string, unknown>([["Tree", tree]])
    const root = describeValueSchema(
      valueSchema({ type: "valueTypeRef", valueTypeId: "Tree" }, valueTypes)
    )
    const children = describeValueSchema(childValueSchema(root, "children"))
    const child = describeValueSchema(childValueSchema(children, "0"))
    expect(describeValueSchema(childValueSchema(child, "label")).kind).toBe("string")
  })
})

describe("walking a value against its schema", () => {
  test("a field the schema does not name is unknown, not open", () => {
    const node = describeValueSchema(
      valueSchema({ type: "object", properties: { name: { schema: "string" } } })
    )
    expect(describeValueSchema(childValueSchema(node, "name")).kind).toBe("string")
    expect(describeValueSchema(childValueSchema(node, "extra")).kind).toBe("unknown")
    // Inherited object keys are not fields.
    expect(describeValueSchema(childValueSchema(node, "toString")).kind).toBe("unknown")
  })

  test("recognizes refs only at declared positions and only when the value matches", () => {
    const refShaped = { objectTypeId: "Room", primaryId: "r-1" }
    const declaredRef = describeValueSchema(
      valueSchema({ type: "objectRef", objectTypeId: "Room" })
    )
    const declaredRecord = describeValueSchema(
      valueSchema({
        type: "object",
        properties: { objectTypeId: { schema: "string" }, primaryId: { schema: "string" } },
      })
    )
    expect(objectRefAt(declaredRef, refShaped)).toEqual(refShaped)
    expect(objectRefAt(declaredRef, "r-1")).toBeNull()
    expect(objectRefAt(declaredRecord, refShaped)).toBeNull()

    expect(fileRefAt(describeValueSchema(valueSchema("fileRef")), fileRef)).toEqual(fileRef)
    expect(fileRefAt(describeValueSchema(valueSchema("fileRef")), "report.pdf")).toBeNull()
    expect(fileRefAt(declaredRecord, fileRef)).toBeNull()
  })

  test("recognizes users only at declared positions and only when the value matches", () => {
    const user = { type: "user", id: "usr_1" } as const
    const declaredUser = describeValueSchema(valueSchema("userRef"))
    const declaredRecord = describeValueSchema(
      valueSchema({
        type: "object",
        properties: { type: { schema: "string" }, id: { schema: "string" } },
      })
    )
    expect(userRefAt(declaredUser, user)).toEqual(user)
    expect(userRefAt(declaredUser, "usr_1")).toBeNull()
    expect(userRefAt(declaredUser, { type: "service", id: "svc_1" })).toBeNull()
    expect(userRefAt(declaredUser, { type: "user", id: "" })).toBeNull()
    expect(userRefAt(declaredRecord, user)).toBeNull()
  })
})

describe("value type collection", () => {
  test("collects inline value types from every ontology declaration, nested ones included", () => {
    const address = {
      type: "object",
      properties: {
        street: { schema: "string" },
        proof: { schema: { type: "valueTypeRef", valueTypeId: "Proof", _resolved: "fileRef" } },
      },
    }
    const valueTypes = collectValueTypeSchemas(
      ontologySchemas([
        {
          properties: [
            {
              schema: {
                type: "array",
                items: { type: "valueTypeRef", valueTypeId: "Address", _resolved: address },
              },
            },
            { schema: { type: "valueTypeRef", valueTypeId: "ByIdOnly" } },
          ],
          links: [
            {
              properties: [
                { schema: { type: "valueTypeRef", valueTypeId: "Weight", _resolved: "double" } },
              ],
            },
          ],
          actions: [
            {
              params: [
                {
                  schema: {
                    type: "map",
                    keySchema: "string",
                    valueSchema: { type: "valueTypeRef", valueTypeId: "Note", _resolved: "string" },
                  },
                },
              ],
            },
          ],
        },
      ])
    )
    expect([...valueTypes.keys()].sort()).toEqual(["Address", "Note", "Proof", "Weight"])
    expect(valueTypes.get("Proof")).toBe("fileRef")
  })

  test("wraps field records whether entries are bare schemas or field configs", () => {
    const schema = fieldRecordSchema({
      caseId: "string",
      attachment: { schema: "fileRef", required: false },
      meta: { type: "object", properties: {} },
    })
    const node = describeValueSchema(valueSchema(schema))
    expect(describeValueSchema(childValueSchema(node, "caseId")).kind).toBe("string")
    expect(describeValueSchema(childValueSchema(node, "attachment")).kind).toBe("fileRef")
    expect(describeValueSchema(childValueSchema(node, "meta")).kind).toBe("object")
  })
})

describe("workflow node IO schemas", () => {
  test("declares an action node's params under its recorded input, and no output", () => {
    const node = {
      type: "action",
      id: "dispatch",
      key: "dispatch",
      params: { report: "fileRef" },
    } satisfies WorkflowNode
    const io = workflowNodeIoSchemas(node)
    const input = describeValueSchema(valueSchema(io.input))
    const params = describeValueSchema(childValueSchema(input, "params"))
    expect(describeValueSchema(childValueSchema(params, "report")).kind).toBe("fileRef")
    expect(describeValueSchema(childValueSchema(input, "subject")).kind).toBe("unknown")
    expect(io.output).toBeNull()
  })

  test("uses an intervention's response as its output", () => {
    const node = {
      type: "intervention",
      id: "review",
      key: "review",
      input: {},
      response: { approvedAt: "timestamp" },
    } satisfies WorkflowNode
    const output = describeValueSchema(valueSchema(workflowNodeIoSchemas(node).output))
    expect(describeValueSchema(childValueSchema(output, "approvedAt")).kind).toBe("timestamp")
  })
})
