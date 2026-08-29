import { describe, expect, test } from "bun:test"
import { compileObjectReadScope } from "../src/storage/objects/read-scope"
import type {
  ObjectReadLinkSelection,
  ObjectReadNode,
  ObjectReadScope,
} from "../src/storage/objects/types"

describe("compileObjectReadScope", () => {
  test("rejects cyclic and pathologically deep selections before provider execution", () => {
    const cyclic: { objects: ObjectReadNode["objects"]; links: ObjectReadLinkSelection[] } = {
      objects: [{ objectTypeId: "Node", propertyIds: ["id"] }],
      links: [],
    }
    cyclic.links.push({ definitions: [definition()], target: cyclic })

    expect(() => compileObjectReadScope(scope(cyclic))).toThrow("cyclic selection node")
    expect(() => compileObjectReadScope(scope(nestedNode(33)))).toThrow("maximum link depth of 32")
  })

  test("bounds the total selection graph independently from provider limits", () => {
    const roots = Array.from({ length: 513 }, (_, index) => ({
      anchor: { objectTypeId: "Node", primaryId: `node-${index}` },
      node: leafNode(),
    }))

    expect(() => compileObjectReadScope({ kind: "selected", roots })).toThrow(
      "maximum of 512 selection nodes"
    )
  })

  test("bounds property and identifier volume independently from graph shape", () => {
    const properties = Array.from({ length: 16_385 }, (_, index) => `property-${index}`)
    expect(() =>
      compileObjectReadScope({
        kind: "selected",
        roots: [
          {
            anchor: { objectTypeId: "Node", primaryId: "root" },
            node: {
              objects: [{ objectTypeId: "Node", propertyIds: properties }],
              links: [],
            },
          },
        ],
      })
    ).toThrow("maximum of 16384 selected property occurrences")

    expect(() =>
      compileObjectReadScope({
        kind: "selected",
        roots: [
          {
            anchor: { objectTypeId: "Node", primaryId: "x".repeat(1_000_001) },
            node: leafNode(),
          },
        ],
      })
    ).toThrow("maximum of 1000000 identifier characters")
  })

  test("bounds raw duplicate input before normalization allocates it", () => {
    expect(() =>
      compileObjectReadScope({
        kind: "selected",
        roots: [
          {
            anchor: { objectTypeId: "Node", primaryId: "root" },
            node: {
              objects: [
                {
                  objectTypeId: "Node",
                  propertyIds: Array.from({ length: 16_385 }, () => "id"),
                },
              ],
              links: [],
            },
          },
        ],
      })
    ).toThrow("maximum of 16384 selected property occurrences")

    expect(() =>
      compileObjectReadScope({
        kind: "selected",
        roots: [
          {
            anchor: { objectTypeId: "Node", primaryId: "root" },
            node: {
              objects: Array.from({ length: 4_097 }, () => ({
                objectTypeId: "Node",
                propertyIds: ["id"],
              })),
              links: [],
            },
          },
        ],
      })
    ).toThrow("maximum of 4096 object selections")
  })
})

function scope(node: ObjectReadNode): ObjectReadScope {
  return {
    kind: "selected",
    roots: [{ anchor: { objectTypeId: "Node", primaryId: "root" }, node }],
  }
}

function nestedNode(depth: number): ObjectReadNode {
  if (depth === 0) return leafNode()
  return {
    objects: [{ objectTypeId: "Node", propertyIds: ["id"] }],
    links: [{ definitions: [definition()], target: nestedNode(depth - 1) }],
  }
}

function leafNode(): ObjectReadNode {
  return { objects: [{ objectTypeId: "Node", propertyIds: ["id"] }], links: [] }
}

function definition() {
  return {
    sourceObjectTypeId: "Node",
    linkId: "next",
    targetObjectTypeIds: ["Node"],
    propertyIds: [],
  }
}
