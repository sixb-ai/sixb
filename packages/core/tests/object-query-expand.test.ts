import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  defineOntology,
  link,
  type ObjectQuery,
  OntologyRegistry,
  prop,
  Sixb,
} from "../src"
import {
  collectObjectQueryValidationIssues,
  explainObjectQuery,
  formatObjectQueryExplanation,
  normalizeObjectQuery,
  validateObjectQuery,
} from "../src/objects/query"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A faithful mirror of the real ADN graph: Project -> { opportunity, projectFolder },
// Opportunity -> { company, contact }, ProjectFolder extends Folder, Folder -> parent
// (a real self-cycle). Cardinality is declared everywhere.
const sortable = { searchable: true, filterable: true, sortable: true } as const

const Company = defineObjectType({
  id: "Company",
  name: "Company",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true, query: sortable }),
  ],
})

const Contact = defineObjectType({
  id: "Contact",
  name: "Contact",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("displayName", "string", { required: true }),
  ],
})

const Opportunity = defineObjectType({
  id: "Opportunity",
  name: "Opportunity",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { required: true }),
    prop("createdAt", "timestamp", { query: sortable }),
  ],
  links: [
    link("contact", Contact, { cardinality: "one" }),
    link("company", Company, { cardinality: "one" }),
  ],
})

const Folder = defineObjectType({
  id: "Folder",
  name: "Folder",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
  links: [link.self("parent", { cardinality: "one" })],
})

const ProjectFolder = defineObjectType({
  id: "ProjectFolder",
  name: "Project Folder",
  extends: Folder,
  properties: [prop("nasComplianceScore", "double", { nullable: true })],
})

const Project = defineObjectType({
  id: "Project",
  name: "Project",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true, query: sortable }),
    prop("updatedAt", "timestamp", { query: sortable }),
  ],
  links: [
    link("opportunity", Opportunity, { cardinality: "one" }),
    link("projectFolder", ProjectFolder, { cardinality: "one" }),
  ],
})

const sources = [Project, Opportunity, Company, Contact, Folder, ProjectFolder]
const ontology = new OntologyRegistry({ sources })
const sixb = new Sixb({
  ontology: [defineOntology({ id: "adn", version: "1.0.0", objectTypes: sources })],
  ...createTestRuntimeDeps(),
})

describe("object query expand — builder", () => {
  test("emits a nested expand hoisted to the outermost layer", () => {
    const ir = sixb
      .objects(Project)
      .query()
      .orderBy(Project.p.updatedAt, "desc")
      .limit(100)
      .expand(Project.l.projectFolder)
      .expand(Project.l.opportunity, (o) =>
        o.expand(Opportunity.l.company).expand(Opportunity.l.contact)
      ).ir

    expect(ir.kind).toBe("expand")
    if (ir.kind !== "expand") return

    // expand is output-shaping → hoisted above limit/sort, which bound the parents first.
    expect(ir.input.kind).toBe("limit")

    expect(ir.expansions.map((expansion) => expansion.linkId)).toEqual([
      "opportunity",
      "projectFolder",
    ])
    const opportunity = ir.expansions.find((expansion) => expansion.linkId === "opportunity")
    expect(opportunity?.direction).toBe("outgoing")
    expect(opportunity?.expand?.map((expansion) => expansion.linkId)).toEqual([
      "company",
      "contact",
    ])
  })

  test("merges duplicate expansions of the same link", () => {
    const ir = sixb
      .objects(Project)
      .query()
      .expand(Project.l.opportunity, (o) => o.expand(Opportunity.l.company))
      .expand(Project.l.opportunity, (o) => o.expand(Opportunity.l.contact)).ir

    expect(ir.kind).toBe("expand")
    if (ir.kind !== "expand") return
    expect(ir.expansions).toHaveLength(1)
    expect(ir.expansions[0]?.linkId).toBe("opportunity")
    expect(ir.expansions[0]?.expand?.map((expansion) => expansion.linkId)).toEqual([
      "company",
      "contact",
    ])
  })

  test("bounds a many-style expansion with limit + orderBy", () => {
    const ir = sixb
      .objects(Project)
      .query()
      .expand(Project.l.opportunity, {
        limit: 5,
        orderBy: [{ property: Opportunity.p.createdAt, direction: "desc" }],
      }).ir

    expect(ir.kind).toBe("expand")
    if (ir.kind !== "expand") return
    const opportunity = ir.expansions[0]
    expect(opportunity?.limit).toBe(5)
    expect(opportunity?.orderBy).toEqual([
      { kind: "property", propertyId: "createdAt", direction: "desc" },
    ])
  })
})

describe("object query expand — normalization", () => {
  test("normalizes authoring order to the same tree (stable cache key)", () => {
    const limitThenExpand = sixb.objects(Project).query().limit(10).expand(Project.l.opportunity).ir
    const expandThenLimit = sixb.objects(Project).query().expand(Project.l.opportunity).limit(10).ir

    expect(expandThenLimit).toEqual(limitThenExpand)
    expect(limitThenExpand.kind).toBe("expand")
  })

  test("hoists a nested expand above sort and limit", () => {
    const ir = normalizeObjectQuery({
      kind: "limit",
      limit: 10,
      input: {
        kind: "sort",
        fields: [{ kind: "property", propertyId: "updatedAt", direction: "desc" }],
        input: {
          kind: "expand",
          expansions: [{ linkId: "opportunity", direction: "outgoing" }],
          input: { kind: "start", objectTypeId: "Project" },
        },
      },
    })

    expect(ir.kind).toBe("expand")
    if (ir.kind !== "expand") return
    expect(ir.input.kind).toBe("limit")
    if (ir.input.kind !== "limit") return
    expect(ir.input.input.kind).toBe("sort")
  })
})

describe("object query expand — validation", () => {
  test("folds expansion targets (including nested) into the touched set", () => {
    const query: ObjectQuery = {
      kind: "expand",
      expansions: [
        { linkId: "projectFolder", direction: "outgoing" },
        {
          linkId: "opportunity",
          direction: "outgoing",
          expand: [
            { linkId: "company", direction: "outgoing" },
            { linkId: "contact", direction: "outgoing" },
          ],
        },
      ],
      input: { kind: "start", objectTypeId: "Project" },
    }

    const validated = validateObjectQuery(query, { ontology })

    // expand is output-shaping: the result type is unchanged.
    expect(validated.result.objectTypeIds).toEqual(["Project"])
    expect([...validated.touchedObjectTypeIds].sort()).toEqual([
      "Company",
      "Contact",
      "Opportunity",
      "Project",
      "ProjectFolder",
    ])
  })

  test("rejects an expand whose link is abandoned by a later traverse", () => {
    const ir = sixb
      .objects(Project)
      .query()
      .expand(Project.l.projectFolder)
      .traverse(Project.l.opportunity).ir

    const issues = collectObjectQueryValidationIssues(ir, { ontology })
    expect(issues.map((issue) => issue.code)).toContain("unknown_expand_link")
  })

  test("rejects an expand over an unknown link", () => {
    const issues = collectObjectQueryValidationIssues(
      {
        kind: "expand",
        expansions: [{ linkId: "nope", direction: "outgoing" }],
        input: { kind: "start", objectTypeId: "Project" },
      },
      { ontology }
    )
    expect(issues.map((issue) => issue.code)).toContain("unknown_expand_link")
  })

  test("rejects a negative expand limit and a non-sortable orderBy target", () => {
    const issues = collectObjectQueryValidationIssues(
      {
        kind: "expand",
        expansions: [
          {
            linkId: "opportunity",
            direction: "outgoing",
            limit: -1,
            orderBy: [{ kind: "property", propertyId: "title" }],
          },
        ],
        input: { kind: "start", objectTypeId: "Project" },
      },
      { ontology }
    )

    const codes = issues.map((issue) => issue.code)
    expect(codes).toContain("invalid_expand_limit")
    expect(codes).toContain("property_not_sortable")
  })

  test("resolves an incoming expansion's source type and folds it into the touched set", () => {
    const validated = validateObjectQuery(
      {
        kind: "expand",
        expansions: [{ linkId: "company", direction: "incoming" }],
        input: { kind: "start", objectTypeId: "Company" },
      },
      { ontology }
    )

    expect(validated.result.objectTypeIds).toEqual(["Company"])
    expect([...validated.touchedObjectTypeIds].sort()).toEqual(["Company", "Opportunity"])
  })
})

describe("object query expand — explain", () => {
  test("renders expand nodes with their nested hops", () => {
    const ir = sixb
      .objects(Project)
      .query()
      .expand(Project.l.opportunity, (o) => o.expand(Opportunity.l.company)).ir

    const explanation = explainObjectQuery(ir, { ontology })
    const formatted = formatObjectQueryExplanation(explanation)

    expect(explanation.valid).toBe(true)
    expect(formatted).toContain("expand opportunity(company)")
  })
})
