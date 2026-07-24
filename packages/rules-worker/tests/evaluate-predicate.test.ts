import { describe, expect, test } from "bun:test"
import { decimal, type RulePredicate } from "@sixb/core"
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
  }
}

function linkRow(linkId: string, targetId = "doc-1"): ObjectLinkRow {
  return {
    projectId: "project-a",
    sourceTypeId: "transaction",
    sourceId: "tx-1",
    linkId,
    targetTypeId: "document",
    targetId,
    createdAt: now,
    updatedAt: now,
  }
}

function evaluate(input: {
  predicate: RulePredicate
  properties?: Record<string, unknown>
  links?: RuleLinkMap
}): boolean {
  return evaluateRulePredicate({
    predicate: input.predicate,
    object: objectRow(input.properties ?? {}),
    links: input.links ?? new Map(),
  })
}

describe("evaluateRulePredicate", () => {
  test("evaluates property equality and inequality", () => {
    expect(
      evaluate({
        predicate: { kind: "property", propertyId: "status", op: "eq", value: "posted" },
        properties: { status: "posted" },
      })
    ).toBe(true)
    expect(
      evaluate({
        predicate: { kind: "property", propertyId: "status", op: "eq", value: "posted" },
        properties: { status: "draft" },
      })
    ).toBe(false)
    expect(
      evaluate({
        predicate: { kind: "property", propertyId: "status", op: "notEq", value: "void" },
        properties: { status: "posted" },
      })
    ).toBe(true)
    expect(
      evaluate({
        predicate: { kind: "property", propertyId: "status", op: "notEq", value: "posted" },
        properties: { status: "posted" },
      })
    ).toBe(false)
  })

  test("evaluates numeric comparisons only for numbers", () => {
    expect(
      evaluate({
        predicate: { kind: "property", propertyId: "amount", op: "gt", value: 10 },
        properties: { amount: 11 },
      })
    ).toBe(true)
    expect(
      evaluate({
        predicate: { kind: "property", propertyId: "amount", op: "gte", value: 10 },
        properties: { amount: 10 },
      })
    ).toBe(true)
    expect(
      evaluate({
        predicate: { kind: "property", propertyId: "amount", op: "lt", value: 10 },
        properties: { amount: 9 },
      })
    ).toBe(true)
    expect(
      evaluate({
        predicate: { kind: "property", propertyId: "amount", op: "lte", value: 10 },
        properties: { amount: 10 },
      })
    ).toBe(true)
    expect(
      evaluate({
        predicate: { kind: "property", propertyId: "amount", op: "gt", value: 10 },
        properties: { amount: "11" },
      })
    ).toBe(false)
    expect(
      evaluate({
        predicate: { kind: "property", propertyId: "amount", op: "gt", value: "10" },
        properties: { amount: 11 },
      })
    ).toBe(false)
  })

  test("evaluates decimal comparisons without JS number coercion", () => {
    expect(
      evaluate({
        predicate: {
          kind: "property",
          propertyId: "amount",
          op: "gt",
          value: decimal("9007199254740992"),
        },
        properties: { amount: decimal("9007199254740993") },
      })
    ).toBe(true)
    expect(
      evaluate({
        predicate: {
          kind: "property",
          propertyId: "amount",
          op: "lt",
          value: decimal("0.0000000000000000001"),
        },
        properties: { amount: decimal("0.00000000000000000002") },
      })
    ).toBe(true)
  })

  test("evaluates property presence and missingness", () => {
    expect(
      evaluate({
        predicate: { kind: "property", propertyId: "amount", op: "isPresent" },
        properties: { amount: 0 },
      })
    ).toBe(true)
    expect(
      evaluate({
        predicate: { kind: "property", propertyId: "description", op: "isPresent" },
        properties: { description: "" },
      })
    ).toBe(true)
    expect(
      evaluate({
        predicate: { kind: "property", propertyId: "amount", op: "isPresent" },
        properties: { amount: null },
      })
    ).toBe(false)
    expect(
      evaluate({
        predicate: { kind: "property", propertyId: "amount", op: "isMissing" },
        properties: { amount: null },
      })
    ).toBe(true)
    expect(
      evaluate({
        predicate: { kind: "property", propertyId: "amount", op: "isMissing" },
        properties: {},
      })
    ).toBe(true)
  })

  test("evaluates link existence and missingness", () => {
    const links = new Map([["document", [linkRow("document")]]])

    expect(
      evaluate({
        predicate: { kind: "link", linkId: "document", op: "exists" },
        links,
      })
    ).toBe(true)
    expect(
      evaluate({
        predicate: { kind: "link", linkId: "receipt", op: "exists" },
        links,
      })
    ).toBe(false)
    expect(
      evaluate({
        predicate: { kind: "link", linkId: "document", op: "isMissing" },
        links,
      })
    ).toBe(false)
    expect(
      evaluate({
        predicate: { kind: "link", linkId: "receipt", op: "isMissing" },
        links,
      })
    ).toBe(true)
  })

  test("evaluates nested all, any, and not predicates", () => {
    const predicate: RulePredicate = {
      kind: "all",
      predicates: [
        { kind: "property", propertyId: "status", op: "eq", value: "posted" },
        {
          kind: "any",
          predicates: [
            { kind: "property", propertyId: "amount", op: "gt", value: 0 },
            { kind: "not", predicate: { kind: "link", linkId: "document", op: "exists" } },
          ],
        },
        {
          kind: "not",
          predicate: { kind: "property", propertyId: "status", op: "eq", value: "void" },
        },
      ],
    }

    expect(
      evaluate({
        predicate,
        properties: { status: "posted", amount: 100 },
        links: new Map([["document", [linkRow("document")]]]),
      })
    ).toBe(true)
    expect(
      evaluate({
        predicate,
        properties: { status: "posted", amount: -1 },
        links: new Map(),
      })
    ).toBe(true)
    expect(
      evaluate({
        predicate,
        properties: { status: "void", amount: 100 },
      })
    ).toBe(false)
  })
})
