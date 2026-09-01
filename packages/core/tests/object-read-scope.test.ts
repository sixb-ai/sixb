import { describe, expect, test } from "bun:test"
import { assertObjectReadOutputWithinLimit, compileSelectedObjectReadScope } from "../src/storage"
import type {
  ObjectReadLinkSelection,
  ObjectReadNode,
  SelectedObjectReadScope,
} from "../src/storage/objects/types"

describe("compileSelectedObjectReadScope", () => {
  test("counts boxed primitives and raw JSON with exact JSON.stringify semantics", () => {
    const encoder = new TextEncoder()
    const byteLength = (value: unknown): number => {
      const serialized = JSON.stringify(value)
      if (serialized === undefined) throw new Error("Expected a JSON-serializable test value.")
      return encoder.encode(serialized).length
    }
    const expectBoundary = (value: unknown, expectedBytes?: number): void => {
      const bytes = byteLength(value)
      if (expectedBytes !== undefined) expect(bytes).toBe(expectedBytes)
      expect(() =>
        assertObjectReadOutputWithinLimit(value, { maxOutputJsonBytes: bytes })
      ).not.toThrow()
      expect(() =>
        assertObjectReadOutputWithinLimit(value, { maxOutputJsonBytes: bytes - 1 })
      ).toThrow(`outputJsonBytes limit (${bytes - 1})`)
    }

    const rawJSON = (JSON as typeof JSON & { rawJSON?: (value: string) => object }).rawJSON
    if (!rawJSON) throw new Error("Expected Bun to support JSON.rawJSON.")
    const specialValues: readonly { readonly value: object; readonly rootBytes: number }[] = [
      { value: new Boolean(true), rootBytes: 4 },
      { value: new Number(123456), rootBytes: 6 },
      { value: new Number(Number.NaN), rootBytes: 4 },
      { value: new Number(Number.POSITIVE_INFINITY), rootBytes: 4 },
      { value: new Number(-0), rootBytes: 1 },
      { value: new String("abcdef"), rootBytes: 8 },
      { value: new String('é\n\\"'), rootBytes: 10 },
      { value: rawJSON("123456789"), rootBytes: 9 },
    ]
    for (const { value, rootBytes } of specialValues) {
      expectBoundary(value, rootBytes)
      expectBoundary({ value })
      expectBoundary([value, value])
    }
    expectBoundary(Object(Symbol("ordinary")), 2)

    let booleanCoercions = 0
    const dynamicBoolean = Object.assign(new Boolean(true), {
      [Symbol.toPrimitive]: () => {
        booleanCoercions += 1
        return false
      },
    })
    expectBoundary(dynamicBoolean, 4)
    expect(booleanCoercions).toBe(0)

    let numberCoercions = 0
    const dynamicNumber = Object.assign(new Number(1), {
      [Symbol.toPrimitive]: () => {
        numberCoercions += 1
        return 123456
      },
    })
    expectBoundary(dynamicNumber, 6)
    expect(numberCoercions).toBe(3)

    let stringCoercions = 0
    const dynamicString = Object.assign(new String("ignored"), {
      toString: () => {
        stringCoercions += 1
        return "abcdef"
      },
    })
    expectBoundary(dynamicString, 8)
    expect(stringCoercions).toBe(3)

    const invalidNumber = Object.assign(new Number(1), {
      [Symbol.toPrimitive]: () => 2n,
    })
    expect(() =>
      assertObjectReadOutputWithinLimit(invalidNumber, { maxOutputJsonBytes: 100 })
    ).toThrow("outputJsonBytes limit (100)")

    expect(() =>
      assertObjectReadOutputWithinLimit(Object(1n), { maxOutputJsonBytes: 100 })
    ).toThrow("outputJsonBytes limit (100)")

    const originalBooleanValueOf = Boolean.prototype.valueOf
    try {
      Boolean.prototype.valueOf = () => false
      expectBoundary(new Boolean(true), 4)
    } finally {
      Boolean.prototype.valueOf = originalBooleanValueOf
    }
  })

  test("counts every occurrence of a shared JSON reference exactly", () => {
    const shared = { a: 1 }
    const value = [shared, shared]

    expect(() => assertObjectReadOutputWithinLimit(value, { maxOutputJsonBytes: 17 })).not.toThrow()
    expect(() => assertObjectReadOutputWithinLimit(value, { maxOutputJsonBytes: 16 })).toThrow(
      "outputJsonBytes limit (16)"
    )
  })

  test("rejects cyclic and pathologically deep selections before provider execution", () => {
    const cyclic: { objects: ObjectReadNode["objects"]; links: ObjectReadLinkSelection[] } = {
      objects: [{ objectTypeId: "Node", propertyIds: ["id"] }],
      links: [],
    }
    cyclic.links.push({ definitions: [definition()], target: cyclic })

    expect(() => compileSelectedObjectReadScope(scope(cyclic))).toThrow("cyclic selection node")
    expect(() => compileSelectedObjectReadScope(scope(nestedNode(33)))).toThrow(
      "maximum link depth of 32"
    )
  })

  test("bounds graph, property, and identifier volume before normalization", () => {
    const roots = Array.from({ length: 513 }, (_, index) => ({
      anchor: { objectTypeId: "Node", primaryId: `node-${index}` },
      node: leafNode(),
    }))
    expect(() => compileSelectedObjectReadScope({ kind: "selected", roots })).toThrow(
      "maximum of 512 selection nodes"
    )

    expect(() =>
      compileSelectedObjectReadScope({
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
      compileSelectedObjectReadScope({
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

  test("bounds compiled property and identifier amplification before concrete allocation", () => {
    expect(() =>
      compileSelectedObjectReadScope({
        kind: "selected",
        roots: [
          {
            anchor: { objectTypeId: "Source", primaryId: "root" },
            node: {
              objects: [{ objectTypeId: "Source", propertyIds: ["id"] }],
              links: [
                {
                  definitions: [
                    {
                      sourceObjectTypeId: "Source",
                      linkId: "targets",
                      targetObjectTypeIds: ["TargetA", "TargetB"],
                      propertyIds: Array.from(
                        { length: 10_000 },
                        (_, index) => `property-${index}`
                      ),
                    },
                  ],
                  target: {
                    objects: [
                      { objectTypeId: "TargetA", propertyIds: [] },
                      { objectTypeId: "TargetB", propertyIds: [] },
                    ],
                    links: [],
                  },
                },
              ],
            },
          },
        ],
      })
    ).toThrow("maximum of 16384 selected property occurrences after compilation")

    const sourceObjectTypeId = "S".repeat(120_000)
    const linkId = "L".repeat(320_000)
    expect(() =>
      compileSelectedObjectReadScope({
        kind: "selected",
        roots: [
          {
            anchor: { objectTypeId: sourceObjectTypeId, primaryId: "root" },
            node: {
              objects: [{ objectTypeId: sourceObjectTypeId, propertyIds: [] }],
              links: [
                {
                  definitions: [
                    {
                      sourceObjectTypeId,
                      linkId,
                      targetObjectTypeIds: ["TargetA", "TargetB"],
                      propertyIds: [],
                    },
                  ],
                  target: {
                    objects: [
                      { objectTypeId: "TargetA", propertyIds: [] },
                      { objectTypeId: "TargetB", propertyIds: [] },
                    ],
                    links: [],
                  },
                },
              ],
            },
          },
        ],
      })
    ).toThrow("maximum of 1000000 identifier characters after compilation")
  })

  test("bounds raw object selections and concrete steps before normalization", () => {
    expect(() =>
      compileSelectedObjectReadScope({
        kind: "selected",
        roots: [
          {
            anchor: { objectTypeId: "Node", primaryId: "root" },
            node: {
              objects: Array.from({ length: 4_097 }, () => ({
                objectTypeId: "Node",
                propertyIds: [],
              })),
              links: [],
            },
          },
        ],
      })
    ).toThrow("maximum of 4096 object selections")

    expect(() =>
      compileSelectedObjectReadScope({
        kind: "selected",
        roots: [
          {
            anchor: { objectTypeId: "Node", primaryId: "root" },
            node: {
              objects: [{ objectTypeId: "Node", propertyIds: [] }],
              links: [
                {
                  definitions: [
                    {
                      sourceObjectTypeId: "Node",
                      linkId: "next",
                      targetObjectTypeIds: Array.from({ length: 2_049 }, () => "Node"),
                      propertyIds: [],
                    },
                  ],
                  target: leafNode(),
                },
              ],
            },
          },
        ],
      })
    ).toThrow("maximum of 2048 concrete link steps")
  })

  test("captures a getter-backed object selection once before enforcing its bound", () => {
    const oversized = Array.from({ length: 4_097 }, () => ({
      objectTypeId: "Node",
      propertyIds: [] as string[],
    }))
    let reads = 0
    const node = {
      get objects() {
        reads += 1
        return reads === 1 ? oversized : [{ objectTypeId: "Node", propertyIds: [] }]
      },
      links: [],
    } as ObjectReadNode

    expect(() => compileSelectedObjectReadScope(scope(node))).toThrow(
      "maximum of 4096 object selections"
    )
    expect(reads).toBe(1)
  })

  test("captures a getter-backed link target exactly once", () => {
    let reads = 0
    const rootNode: ObjectReadNode = {
      objects: [{ objectTypeId: "Node", propertyIds: ["id"] }],
      links: [
        {
          definitions: [definition()],
          get target() {
            reads += 1
            return reads === 1
              ? leafNode()
              : {
                  objects: [{ objectTypeId: "Secret", propertyIds: ["id"] }],
                  links: [],
                }
          },
        },
      ],
    }

    const compiled = compileSelectedObjectReadScope(scope(rootNode))

    expect(reads).toBe(1)
    expect(compiled.objects.map((selection) => selection.objectTypeId)).toEqual(["Node", "Node"])
  })

  test("does not invoke caller-controlled array iteration hooks", () => {
    let calls = 0
    const roots = [
      {
        anchor: { objectTypeId: "Node", primaryId: "root" },
        node: leafNode(),
      },
    ]
    const rejectIteration = () => {
      calls += 1
      throw new Error("hostile iterator invoked")
    }
    Object.defineProperty(roots, "entries", { value: rejectIteration })
    Object.defineProperty(roots, Symbol.iterator, { value: rejectIteration })

    const compiled = compileSelectedObjectReadScope({ kind: "selected", roots })

    expect(compiled.roots).toHaveLength(1)
    expect(calls).toBe(0)
  })

  test("detaches a captured field before a later getter can mutate its source", () => {
    const object = { objectTypeId: "Node", propertyIds: ["id"] }
    const objects = [object]
    let linkReads = 0
    const node = {
      objects,
      get links() {
        linkReads += 1
        object.objectTypeId = "Secret"
        object.propertyIds.push("secret")
        objects.splice(0, objects.length)
        return []
      },
    } as ObjectReadNode

    const compiled = compileSelectedObjectReadScope(scope(node))
    object.propertyIds.push("later")

    expect(linkReads).toBe(1)
    expect(compiled.objects).toEqual([{ nodeId: 0, objectTypeId: "Node", propertyIds: ["id"] }])
  })

  test("detaches, deeply freezes, and normalizes the compiled artifact", () => {
    const raw: SelectedObjectReadScope = {
      kind: "selected",
      roots: [
        {
          anchor: { objectTypeId: "Node", primaryId: "root" },
          node: {
            objects: [
              { objectTypeId: "Node", propertyIds: ["name", "id"] },
              { objectTypeId: "Node", propertyIds: ["name", "rank"] },
            ],
            links: [
              {
                definitions: [definition(["position"]), definition(["label", "position"])],
                target: leafNode(),
              },
            ],
          },
        },
      ],
    }

    const compiled = compileSelectedObjectReadScope(raw)
    ;(raw.roots[0]!.node.objects[0]!.propertyIds as string[]).push("secret")
    ;(raw.roots as Array<unknown>).splice(0)

    expect(compiled.objects[0]?.propertyIds).toEqual(["id", "name", "rank"])
    expect(compiled.steps).toHaveLength(1)
    expect(compiled.steps[0]?.propertyIds).toEqual(["label", "position"])
    expect(compiled.roots).toHaveLength(1)
    expect(Object.isFrozen(compiled)).toBe(true)
    expect(Object.isFrozen(compiled.roots)).toBe(true)
    expect(Object.isFrozen(compiled.roots[0])).toBe(true)
    expect(Object.isFrozen(compiled.objects[0]?.propertyIds)).toBe(true)
    expect(Object.isFrozen(compiled.steps[0]?.propertyIds)).toBe(true)
  })

  test("assigns a distinct node id to every reused path occurrence", () => {
    const sharedChild = leafNode()
    const compiled = compileSelectedObjectReadScope({
      kind: "selected",
      roots: [
        {
          anchor: { objectTypeId: "Node", primaryId: "root" },
          node: {
            objects: [{ objectTypeId: "Node", propertyIds: ["id"] }],
            links: [
              { definitions: [definition()], target: sharedChild },
              { definitions: [definition()], target: sharedChild },
            ],
          },
        },
      ],
    })

    expect(new Set(compiled.steps.map((step) => step.nodeId)).size).toBe(2)
  })
})

function scope(node: ObjectReadNode): SelectedObjectReadScope {
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

function definition(propertyIds: readonly string[] = []) {
  return {
    sourceObjectTypeId: "Node",
    linkId: "next",
    targetObjectTypeIds: ["Node"],
    propertyIds,
  }
}
