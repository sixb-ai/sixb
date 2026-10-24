import { describe, expect, test } from "bun:test"
import type { ObjectQueryPredicate } from "../src/objects/query"
import { currentUser } from "../src/ontology/user-ref"
import {
  type CompiledConditionalObjectReadScope,
  type ConditionalObjectReadScope,
  compileConditionalObjectReadScope,
  type ObjectReadCondition,
} from "../src/storage"

const notDraft: ObjectQueryPredicate = {
  op: "neq",
  propertyId: "status",
  value: "draft",
  scalarKind: "string",
}

describe("compileConditionalObjectReadScope", () => {
  test("detaches and freezes the conditions, ordered by type", () => {
    const tags = ["urgent"]
    const raw = {
      kind: "conditional",
      conditions: [
        {
          objectTypeId: "Ticket",
          predicate: { op: "in", propertyId: "tags", values: [tags], scalarKind: "string" },
        },
        { objectTypeId: "Invoice", predicate: notDraft },
      ],
    } satisfies ConditionalObjectReadScope

    const compiled = compileConditionalObjectReadScope(raw)
    tags.push("mutated")

    expect(shapeOf(compiled)).toEqual({
      kind: "conditional",
      conditions: [
        { objectTypeId: "Invoice", predicate: notDraft },
        {
          objectTypeId: "Ticket",
          predicate: { op: "in", propertyId: "tags", values: [["urgent"]], scalarKind: "string" },
        },
      ],
    })
    expect(Object.isFrozen(compiled.conditions)).toBe(true)
    expect(Object.isFrozen(compiled.conditions[1]?.predicate)).toBe(true)

    const ticket = compiled.conditions[1]?.predicate
    if (ticket?.op !== "in") throw new Error("expected an in predicate")
    expect(Object.isFrozen(ticket.values[0])).toBe(true)
  })

  test("types a raw scope apart from a compiled one", () => {
    const raw: ConditionalObjectReadScope = { kind: "conditional", conditions: [] }

    // @ts-expect-error a raw scope reaches a provider only through the compiler
    const unchecked: CompiledConditionalObjectReadScope = raw

    expect(shapeOf(unchecked)).toBe(raw)
  })

  test("accepts no conditions", () => {
    const compiled = compileConditionalObjectReadScope({ kind: "conditional", conditions: [] })
    expect(shapeOf(compiled)).toEqual({
      kind: "conditional",
      conditions: [],
    })
  })

  test.each([
    ["a selected scope", { kind: "selected", roots: [] }, "must be a conditional scope"],
    ["conditions that are not an array", { kind: "conditional" }, "conditions must be an array"],
    [
      "a blank object type",
      { kind: "conditional", conditions: [{ objectTypeId: " ", predicate: notDraft }] },
      "conditions[0].objectTypeId must be a non-empty string",
    ],
    [
      "a padded object type",
      { kind: "conditional", conditions: [{ objectTypeId: " Invoice", predicate: notDraft }] },
      "conditions[0].objectTypeId must not start or end with whitespace",
    ],
    [
      "two conditions on one type",
      {
        kind: "conditional",
        conditions: [
          { objectTypeId: "Invoice", predicate: notDraft },
          { objectTypeId: "Invoice", predicate: { op: "constant", value: true } },
        ],
      },
      "conditions[1] repeats the condition on 'Invoice'",
    ],
    ["a missing predicate", conditionOf(undefined), "predicate must be a query predicate"],
    ["an unknown operator", conditionOf({ op: "like" }), "predicate.op must be a query predicate"],
    ["an empty group", conditionOf({ op: "or", items: [] }), "predicate.items must not be empty"],
    [
      "an empty in",
      conditionOf({ op: "in", propertyId: "status", values: [] }),
      "predicate.values must not be empty",
    ],
    [
      "a non-boolean constant",
      conditionOf({ op: "constant", value: "yes" }),
      "predicate.value must be a boolean",
    ],
    [
      "a value that is not JSON",
      conditionOf({ op: "lt", propertyId: "dueAt", value: new Date(0) }),
      "predicate.value must be a JSON value",
    ],
    [
      "an unknown scalar kind",
      conditionOf({ op: "eq", propertyId: "status", value: "paid", scalarKind: "text" }),
      "predicate.scalarKind must be a query scalar kind",
    ],
    [
      "an unbound currentUser()",
      conditionOf({
        op: "not",
        item: { op: "in", propertyId: "owner", values: [currentUser()] },
      }),
      "predicate.item.values[0] holds currentUser()",
    ],
    [
      "a predicate nested too deeply",
      conditionOf(nested(33)),
      "exceeds the maximum predicate depth of 32",
    ],
    [
      "too many predicate nodes",
      conditionOf({
        op: "and",
        items: Array.from({ length: 4_096 }, () => ({ op: "constant", value: true })),
      }),
      "scope exceeds the maximum of 4096 predicate nodes",
    ],
  ])("refuses %s", (_name, raw, message) => {
    const error = (() => {
      try {
        compileConditionalObjectReadScope(raw as unknown as ConditionalObjectReadScope)
      } catch (caught) {
        return caught
      }
    })()

    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain("[Sixb] Invalid object read scope:")
    expect(String(error)).toContain(message)
  })
})

/** The runtime shape a provider reads; the compiled brand exists in types only. */
function shapeOf(scope: CompiledConditionalObjectReadScope): ConditionalObjectReadScope {
  return scope
}

function conditionOf(predicate: unknown): { kind: "conditional"; conditions: unknown[] } {
  return { kind: "conditional", conditions: [{ objectTypeId: "Invoice", predicate }] }
}

function nested(depth: number): ObjectReadCondition["predicate"] {
  let predicate: ObjectReadCondition["predicate"] = { op: "constant", value: true }
  for (let level = 0; level < depth; level += 1) predicate = { op: "not", item: predicate }
  return predicate
}
