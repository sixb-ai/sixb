import { expect, test } from "bun:test"
import {
  decimal,
  type PredicateValue,
  type PropertyPredicateOperator,
  type RulePredicate,
} from "@sixb/core"
import type { ObjectLinkRow, ObjectRow } from "@sixb/core/storage"
import { evaluateRulePredicate } from "../src/evaluate-predicate"
import type { RuleLinkMap } from "../src/types"

const now = new Date("2026-05-07T10:00:00.000Z")

function objectRow(properties: Record<string, unknown>): ObjectRow {
  return {
    projectId: "project-a",
    objectTypeId: "transaction",
    primaryId: "tx-1",
    properties,
    createdAt: now,
    updatedAt: now,
    version: 1,
    lastCommitId: "commit-1",
  }
}

function linkRow(linkId: string): ObjectLinkRow {
  return {
    projectId: "project-a",
    sourceTypeId: "transaction",
    sourceId: "tx-1",
    linkId,
    targetTypeId: "document",
    targetId: "doc-1",
    createdAt: now,
    updatedAt: now,
    lastCommitId: "commit-1",
  }
}

const withDocument: RuleLinkMap = new Map([["document", [linkRow("document")]]])

function property(
  propertyId: string,
  op: PropertyPredicateOperator,
  value?: PredicateValue
): RulePredicate {
  return { kind: "property", propertyId, op, ...(value === undefined ? {} : { value }) }
}

const reviewPredicate: RulePredicate = {
  kind: "all",
  predicates: [
    property("status", "eq", "posted"),
    {
      kind: "any",
      predicates: [
        property("amount", "gt", 0),
        { kind: "not", predicate: { kind: "link", linkId: "document", op: "exists" } },
      ],
    },
    { kind: "not", predicate: property("status", "eq", "void") },
  ],
}

const cases: {
  readonly name: string
  readonly predicate: RulePredicate
  readonly properties?: Record<string, unknown>
  readonly links?: RuleLinkMap
  readonly expected: boolean
}[] = [
  {
    name: "eq matches",
    predicate: property("status", "eq", "posted"),
    properties: { status: "posted" },
    expected: true,
  },
  {
    name: "eq rejects",
    predicate: property("status", "eq", "posted"),
    properties: { status: "draft" },
    expected: false,
  },
  {
    name: "notEq matches",
    predicate: property("status", "notEq", "void"),
    properties: { status: "posted" },
    expected: true,
  },
  {
    name: "notEq rejects",
    predicate: property("status", "notEq", "posted"),
    properties: { status: "posted" },
    expected: false,
  },
  {
    name: "gt",
    predicate: property("amount", "gt", 10),
    properties: { amount: 11 },
    expected: true,
  },
  {
    name: "gte at the bound",
    predicate: property("amount", "gte", 10),
    properties: { amount: 10 },
    expected: true,
  },
  {
    name: "lt",
    predicate: property("amount", "lt", 10),
    properties: { amount: 9 },
    expected: true,
  },
  {
    name: "lte at the bound",
    predicate: property("amount", "lte", 10),
    properties: { amount: 10 },
    expected: true,
  },
  {
    name: "a numeric comparison does not coerce a string value",
    predicate: property("amount", "gt", 10),
    properties: { amount: "11" },
    expected: false,
  },
  {
    name: "a numeric comparison does not coerce a string operand",
    predicate: property("amount", "gt", "10"),
    properties: { amount: 11 },
    expected: false,
  },
  {
    name: "decimal gt beyond JS number precision",
    predicate: property("amount", "gt", decimal("9007199254740992")),
    properties: { amount: decimal("9007199254740993") },
    expected: true,
  },
  {
    name: "decimal lt below JS number precision",
    predicate: property("amount", "lt", decimal("0.0000000000000000001")),
    properties: { amount: decimal("0.00000000000000000002") },
    expected: true,
  },
  {
    name: "isPresent accepts zero",
    predicate: property("amount", "isPresent"),
    properties: { amount: 0 },
    expected: true,
  },
  {
    name: "isPresent accepts an empty string",
    predicate: property("description", "isPresent"),
    properties: { description: "" },
    expected: true,
  },
  {
    name: "isPresent rejects null",
    predicate: property("amount", "isPresent"),
    properties: { amount: null },
    expected: false,
  },
  {
    name: "isMissing accepts null",
    predicate: property("amount", "isMissing"),
    properties: { amount: null },
    expected: true,
  },
  {
    name: "isMissing accepts an absent property",
    predicate: property("amount", "isMissing"),
    properties: {},
    expected: true,
  },
  {
    name: "link exists",
    predicate: { kind: "link", linkId: "document", op: "exists" },
    links: withDocument,
    expected: true,
  },
  {
    name: "an unloaded link does not exist",
    predicate: { kind: "link", linkId: "receipt", op: "exists" },
    links: withDocument,
    expected: false,
  },
  {
    name: "link isMissing rejects a present link",
    predicate: { kind: "link", linkId: "document", op: "isMissing" },
    links: withDocument,
    expected: false,
  },
  {
    name: "an unloaded link is missing",
    predicate: { kind: "link", linkId: "receipt", op: "isMissing" },
    links: withDocument,
    expected: true,
  },
  {
    name: "nested all/any/not through the first any branch",
    predicate: reviewPredicate,
    properties: { status: "posted", amount: 100 },
    links: withDocument,
    expected: true,
  },
  {
    name: "nested all/any/not through the negated link branch",
    predicate: reviewPredicate,
    properties: { status: "posted", amount: -1 },
    expected: true,
  },
  {
    name: "nested all/any/not rejected by its negated clause",
    predicate: reviewPredicate,
    properties: { status: "void", amount: 100 },
    expected: false,
  },
]

test.each(cases)("evaluateRulePredicate: $name", ({ predicate, properties, links, expected }) => {
  expect(
    evaluateRulePredicate({
      predicate,
      object: objectRow(properties ?? {}),
      links: links ?? new Map(),
    })
  ).toBe(expected)
})
