import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { OntologySource, RuleDefinition } from "../src"
import { createSixb, defineObjectType, defineRule, InMemoryBroker, link, prop, Sixb } from "../src"
import { EventsRuntime } from "../src/events"
import { deriveRuleEventDependencies } from "../src/rules"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const coreModuleUrl = pathToFileURL(resolve(import.meta.dir, "..", "src", "index.ts")).href
const tempRoots = new Set<string>()

const Document = defineObjectType({
  id: "document",
  name: "Document",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Transaction = defineObjectType({
  id: "transaction",
  name: "Transaction",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string"),
    prop("amount", "double"),
  ],
  links: [
    link("document", Document, { cardinality: "one" }),
    link("receipt", Document, { cardinality: "one" }),
  ],
})

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true })
  }
  tempRoots.clear()
})

describe("rules", () => {
  test("defineRule returns an inert rule definition", () => {
    const rule = defineRule("transaction.requires-document")
      .on(Transaction)
      .where((tx) => tx.l.document.isMissing())

    expect(rule).toEqual({
      kind: "rule",
      id: "transaction.requires-document",
      subject: { kind: "object", objectTypeId: "transaction" },
      predicate: { kind: "link", linkId: "document", op: "isMissing" },
    })
  })

  test("property predicates produce the expected AST", () => {
    const rule = defineRule("transaction.property-predicates")
      .on(Transaction)
      .where((tx) =>
        tx.all(
          tx.p.status.eq("posted"),
          tx.p.status.notEq("void"),
          tx.p.amount.gt(0),
          tx.p.amount.gte(0),
          tx.p.amount.lt(1000),
          tx.p.amount.lte(1000),
          tx.p.amount.isPresent(),
          tx.p.amount.isMissing()
        )
      )

    expect(rule.predicate).toEqual({
      kind: "all",
      predicates: [
        { kind: "property", propertyId: "status", op: "eq", value: "posted" },
        { kind: "property", propertyId: "status", op: "notEq", value: "void" },
        { kind: "property", propertyId: "amount", op: "gt", value: 0 },
        { kind: "property", propertyId: "amount", op: "gte", value: 0 },
        { kind: "property", propertyId: "amount", op: "lt", value: 1000 },
        { kind: "property", propertyId: "amount", op: "lte", value: 1000 },
        { kind: "property", propertyId: "amount", op: "isPresent" },
        { kind: "property", propertyId: "amount", op: "isMissing" },
      ],
    })
  })

  test("link predicates produce the expected AST", () => {
    const rule = defineRule("transaction.link-predicates")
      .on(Transaction)
      .where((tx) => tx.all(tx.l.document.exists(), tx.l.document.isMissing()))

    expect(rule.predicate).toEqual({
      kind: "all",
      predicates: [
        { kind: "link", linkId: "document", op: "exists" },
        { kind: "link", linkId: "document", op: "isMissing" },
      ],
    })
  })

  test("all, any, and not produce nested AST", () => {
    const rule = defineRule("transaction.nested")
      .on(Transaction)
      .where((tx) =>
        tx.all(tx.p.status.eq("posted"), tx.any(tx.p.amount.gt(0), tx.not(tx.p.status.eq("void"))))
      )

    expect(rule.predicate).toEqual({
      kind: "all",
      predicates: [
        { kind: "property", propertyId: "status", op: "eq", value: "posted" },
        {
          kind: "any",
          predicates: [
            { kind: "property", propertyId: "amount", op: "gt", value: 0 },
            {
              kind: "not",
              predicate: { kind: "property", propertyId: "status", op: "eq", value: "void" },
            },
          ],
        },
      ],
    })
  })

  test("deriveRuleEventDependencies includes the subject object event", () => {
    const rule = defineRule("transaction.posted")
      .on(Transaction)
      .where((tx) => tx.p.status.eq("posted"))

    expect(deriveRuleEventDependencies(rule)).toEqual([
      { type: "object.created", objectTypeId: "transaction" },
      { type: "object.updated", objectTypeId: "transaction" },
      { type: "object.deleted", objectTypeId: "transaction" },
    ])
  })

  test("deriveRuleEventDependencies includes link mutation events", () => {
    const rule = defineRule("transaction.linked-docs")
      .on(Transaction)
      .where((tx) =>
        tx.all(tx.l.document.isMissing(), tx.l.receipt.exists(), tx.l.document.exists())
      )

    expect(deriveRuleEventDependencies(rule)).toEqual([
      { type: "object.created", objectTypeId: "transaction" },
      { type: "object.updated", objectTypeId: "transaction" },
      { type: "object.deleted", objectTypeId: "transaction" },
      { type: "link.created", sourceTypeId: "transaction", linkId: "document" },
      { type: "link.updated", sourceTypeId: "transaction", linkId: "document" },
      { type: "link.deleted", sourceTypeId: "transaction", linkId: "document" },
      { type: "link.created", sourceTypeId: "transaction", linkId: "receipt" },
      { type: "link.updated", sourceTypeId: "transaction", linkId: "receipt" },
      { type: "link.deleted", sourceTypeId: "transaction", linkId: "receipt" },
    ])
  })

  test("invalid empty rule ids throw a rule validation error", () => {
    expect(() => defineRule("")).toThrow(
      expect.objectContaining({ code: "runtime.invalid_definition" })
    )
    expect(() => defineRule("")).toThrow("Rule id must not be empty.")
  })

  test("discovery loads exports from rules", async () => {
    const projectRoot = await createTempProjectRoot()

    await writeProjectFile(
      projectRoot,
      "ontology/types.ts",
      `import { defineObjectType, link, prop } from "${coreModuleUrl}"

export const Document = defineObjectType({
  id: "document",
  name: "Document",
  properties: [prop("id", "string", { required: true, primary: true })],
})

export const Transaction = defineObjectType({
  id: "transaction",
  name: "Transaction",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link("document", Document, { cardinality: "one" })],
})
`
    )

    await writeProjectFile(
      projectRoot,
      "rules/transaction.ts",
      `import { defineRule } from "${coreModuleUrl}"
import { Transaction } from "../ontology/types"

export const transactionRequiresDocument = defineRule("transaction.requires-document")
  .on(Transaction)
  .where((tx) => tx.l.document.isMissing())
`
    )

    const sixb = await createSixb({
      projectRoot,
      ...createTestRuntimeDeps(),
    })

    expect(sixb.listRules().map((rule) => rule.id)).toEqual(["transaction.requires-document"])
    expect(sixb.getRuleById("transaction.requires-document")?.predicate).toEqual({
      kind: "link",
      linkId: "document",
      op: "isMissing",
    })
  })

  test("runtime registration rejects duplicate rule ids", () => {
    const rule1 = defineRule("duplicate-rule")
      .on(Transaction)
      .where((tx) => tx.l.document.exists())
    const rule2 = defineRule("duplicate-rule")
      .on(Transaction)
      .where((tx) => tx.l.document.isMissing())

    expect(() => createRuntimeWithRules([rule1, rule2])).toThrow(
      expect.objectContaining({ code: "runtime.invalid_definition" })
    )
  })

  test("runtime registration rejects predicates for unknown properties", () => {
    const rule: RuleDefinition = {
      kind: "rule",
      id: "transaction.unknown-property",
      subject: { kind: "object", objectTypeId: "transaction" },
      predicate: { kind: "property", propertyId: "missing", op: "isPresent" },
    }

    expect(() => createRuntimeWithRules([rule])).toThrow('unknown property "missing"')
  })

  test("runtime registration rejects predicates for unknown links", () => {
    const rule: RuleDefinition = {
      kind: "rule",
      id: "transaction.unknown-link",
      subject: { kind: "object", objectTypeId: "transaction" },
      predicate: { kind: "link", linkId: "missing", op: "isMissing" },
    }

    expect(() => createRuntimeWithRules([rule])).toThrow('unknown link "missing"')
  })

  test("runtime registration rejects empty predicate groups", () => {
    const rule: RuleDefinition = {
      kind: "rule",
      id: "transaction.empty-group",
      subject: { kind: "object", objectTypeId: "transaction" },
      predicate: { kind: "all", predicates: [] },
    }

    expect(() => createRuntimeWithRules([rule])).toThrow(
      "all predicate must contain at least one predicate"
    )
  })

  test("rule transition events use the rules topic and stable partition key", async () => {
    const events = new EventsRuntime({
      projectId: "test",
      broker: new InMemoryBroker(),
      host: null,
    })
    const [stored] = await events.append({
      events: [
        {
          type: "rule.triggered",
          payload: {
            ruleId: "transaction.requires-document",
            subject: {
              kind: "object",
              objectTypeId: "transaction",
              primaryId: "tx-1",
            },
            triggeredAt: "2026-05-06T00:00:00.000Z",
          },
        },
      ],
    })

    expect(stored.type).toBe("rule.triggered")
    expect(stored.topic).toBe("rules")
    expect(stored.partitionKey).toBe("transaction.requires-document:transaction:tx-1")
  })
})

async function createTempProjectRoot(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "sixb-core-rules-"))
  tempRoots.add(projectRoot)
  return projectRoot
}

function createRuntimeWithRules(rules: readonly RuleDefinition[]): Sixb<readonly OntologySource[]> {
  return new Sixb<readonly OntologySource[]>({
    ontology: [Transaction, Document],
    rules,
    ...createTestRuntimeDeps(),
  })
}

async function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  content: string
): Promise<void> {
  const absolutePath = join(projectRoot, relativePath)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, content, "utf-8")
}
