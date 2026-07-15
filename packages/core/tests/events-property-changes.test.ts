import { describe, expect, test } from "bun:test"
import { clearedPropertyChanges, diffPropertyChanges } from "../src/events"

describe("diffPropertyChanges", () => {
  test("marks provided properties as created when there is no previous row", () => {
    expect(diffPropertyChanges(undefined, { amount: 700, status: "paid" })).toEqual({
      amount: { operation: "created", after: 700 },
      status: { operation: "created", after: "paid" },
    })
  })

  test("marks changed provided properties as updated with before and after values", () => {
    expect(diffPropertyChanges({ amount: 400, status: "draft" }, { amount: 700 })).toEqual({
      amount: { operation: "updated", before: 400, after: 700 },
    })
  })

  test("marks provided null values as cleared when the property existed", () => {
    expect(diffPropertyChanges({ amount: 400 }, { amount: null })).toEqual({
      amount: { operation: "cleared", before: 400, after: null },
    })
  })

  test("ignores unchanged JSON-equivalent values", () => {
    expect(
      diffPropertyChanges(
        { metadata: { b: 2, a: 1 }, tags: ["vip", "paid"] },
        { metadata: { a: 1, b: 2 }, tags: ["vip", "paid"] }
      )
    ).toEqual({})
  })

  test("does not treat missing patch keys as cleared", () => {
    expect(diffPropertyChanges({ amount: 400, status: "draft" }, { status: "draft" })).toEqual({})
  })

  test("returns an empty map for an empty or absent patch", () => {
    expect(diffPropertyChanges({ amount: 400 }, {})).toEqual({})
    expect(diffPropertyChanges({ amount: 400 }, undefined)).toEqual({})
  })
})

describe("clearedPropertyChanges", () => {
  test("marks every previous property as cleared", () => {
    expect(clearedPropertyChanges({ amount: 400, status: "draft" })).toEqual({
      amount: { operation: "cleared", before: 400, after: null },
      status: { operation: "cleared", before: "draft", after: null },
    })
  })
})
