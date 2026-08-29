import { describe, expect, test } from "bun:test"
import type { RuntimeAccessPlan } from "../src/authorization/access-plan"
import { AuthorizationError } from "../src/authorization/errors"
import type { ObjectQuery } from "../src/objects/query/ir"
import { assertObjectQueryAuthorizedByAccessPlan } from "../src/objects/query/read-scope-authorization"
import { defineObjectType, link, OntologyRegistry, prop } from "../src/ontology"

const Product = defineObjectType({
  id: "Product",
  name: "Product",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      query: { searchable: true, text: true, filterable: true, sortable: true },
    }),
    prop("margin", "double", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
  ],
})

const LineItem = defineObjectType({
  id: "LineItem",
  name: "Line item",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      query: { searchable: true, text: true, filterable: true, sortable: true },
    }),
    prop("role", "string", {
      query: { searchable: true, text: true, filterable: true, sortable: true },
    }),
    prop("cost", "double", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop(
      "embedding",
      { type: "array", items: "double" },
      { query: { searchable: true, vector: true } }
    ),
    prop(
      "privateEmbedding",
      { type: "array", items: "double" },
      { query: { searchable: true, vector: true } }
    ),
  ],
  links: [link("product", Product)],
})

const Proposal = defineObjectType({
  id: "Proposal",
  name: "Proposal",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", {
      query: { searchable: true, text: true, filterable: true, sortable: true },
    }),
    prop("secret", "string", {
      query: { searchable: true, text: true, filterable: true, sortable: true },
    }),
  ],
  links: [link("items", LineItem), link("reviewers", LineItem)],
  search: { defaultText: ["title", "secret"] },
})

const ontology = new OntologyRegistry({ sources: [Proposal, LineItem, Product] })

const accessPlan: RuntimeAccessPlan = {
  grants: [
    {
      kind: "object.view",
      selection: {
        kind: "selected",
        roots: [
          {
            anchor: { objectTypeId: "Proposal", primaryId: "proposal-1" },
            node: {
              objects: [{ objectTypeId: "Proposal", propertyIds: ["id", "title"] }],
              links: [
                {
                  definitions: [
                    {
                      sourceObjectTypeId: "Proposal",
                      linkId: "items",
                      targetObjectTypeIds: ["LineItem"],
                      propertyIds: [],
                    },
                  ],
                  target: {
                    objects: [
                      {
                        objectTypeId: "LineItem",
                        propertyIds: ["id", "name", "embedding"],
                      },
                    ],
                    links: [
                      {
                        definitions: [
                          {
                            sourceObjectTypeId: "LineItem",
                            linkId: "product",
                            targetObjectTypeIds: ["Product"],
                            propertyIds: [],
                          },
                        ],
                        target: {
                          objects: [{ objectTypeId: "Product", propertyIds: ["id", "name"] }],
                          links: [],
                        },
                      },
                    ],
                  },
                },
                {
                  definitions: [
                    {
                      sourceObjectTypeId: "Proposal",
                      linkId: "reviewers",
                      targetObjectTypeIds: ["LineItem"],
                      propertyIds: [],
                    },
                  ],
                  target: {
                    objects: [
                      {
                        objectTypeId: "LineItem",
                        propertyIds: ["id", "role", "embedding"],
                      },
                    ],
                    links: [],
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      kind: "action.apply",
      actionId: "approve",
      subjects: [{ objectTypeId: "Proposal", primaryId: "proposal-1" }],
    },
  ],
}

describe("object query read-scope authorization", () => {
  test("admits exact refs only for object types selected by the access plan", () => {
    expectAuthorized({
      kind: "refs",
      refs: [
        { objectTypeId: "Proposal", primaryId: "proposal-1" },
        { objectTypeId: "Product", primaryId: "product-1" },
      ],
    })

    const denied = expectDenied({
      kind: "refs",
      refs: [{ objectTypeId: "Unselected", primaryId: "known-id" }],
    })
    expect(denied.grantKey).toBe("view:object:Unselected")
    expect(denied.message).toContain("does not select that type")
  })

  test("preserves exact path provenance across outgoing and incoming traversals", () => {
    expectAuthorized({
      kind: "traverse",
      linkId: "product",
      direction: "outgoing",
      input: traverse("items", start("Proposal")),
    })

    const borrowed = expectDenied({
      kind: "traverse",
      linkId: "product",
      direction: "outgoing",
      input: traverse("reviewers", start("Proposal")),
    })
    expect(borrowed.grantKey).toBe("view:link:outgoing:product")
    expect(borrowed.message).toContain("'LineItem'@node 3")
    expect(borrowed.message).toContain("withLinks(...)")

    expectAuthorized({
      kind: "traverse",
      linkId: "items",
      direction: "incoming",
      sourceObjectTypeId: "Proposal",
      input: {
        kind: "traverse",
        linkId: "product",
        direction: "incoming",
        sourceObjectTypeId: "LineItem",
        input: start("Product"),
      },
    })
  })

  test("preserves provenance through nested outgoing and incoming expansions", () => {
    expectAuthorized({
      kind: "expand",
      input: start("Proposal"),
      expansions: [
        {
          linkId: "items",
          direction: "outgoing",
          expand: [
            {
              linkId: "product",
              direction: "outgoing",
              orderBy: [{ kind: "property", propertyId: "name" }],
            },
          ],
        },
      ],
    })

    expectDenied({
      kind: "expand",
      input: start("Proposal"),
      expansions: [
        {
          linkId: "reviewers",
          direction: "outgoing",
          expand: [{ linkId: "product", direction: "outgoing" }],
        },
      ],
    })

    expectAuthorized({
      kind: "expand",
      input: start("Product"),
      expansions: [
        {
          linkId: "product",
          direction: "incoming",
          sourceObjectTypeId: "LineItem",
          expand: [
            {
              linkId: "items",
              direction: "incoming",
              sourceObjectTypeId: "Proposal",
            },
          ],
        },
      ],
    })
  })

  test("rejects every property-bearing query operation before storage", () => {
    const deniedQueries: readonly [string, ObjectQuery][] = [
      [
        "filter",
        {
          kind: "filter",
          input: start("Proposal"),
          predicate: {
            op: "not",
            item: { op: "eq", propertyId: "secret", value: "hidden" },
          },
        },
      ],
      [
        "sort",
        {
          kind: "sort",
          input: start("Proposal"),
          fields: [{ kind: "property", propertyId: "secret" }],
        },
      ],
      ["text", { kind: "text", input: start("Proposal"), query: "hidden", fields: ["secret"] }],
      [
        "vector",
        {
          kind: "vector",
          input: start("LineItem"),
          propertyId: "privateEmbedding",
          vector: [1],
          k: 1,
        },
      ],
      ["project", { kind: "project", input: start("Proposal"), properties: ["secret"] }],
      [
        "expansion orderBy",
        {
          kind: "expand",
          input: start("Proposal"),
          expansions: [
            {
              linkId: "items",
              direction: "outgoing",
              orderBy: [{ kind: "property", propertyId: "cost" }],
            },
          ],
        },
      ],
    ]

    for (const [operation, query] of deniedQueries) {
      expect(expectDenied(query).message).toContain(operation)
    }

    // Omitting text fields is still checked against ontology-resolved defaults.
    expect(
      expectDenied({ kind: "text", input: start("Proposal"), query: "hidden" }).message
    ).toContain("secret")

    expectAuthorized({
      kind: "filter",
      input: start("Proposal"),
      predicate: { op: "eq", propertyId: "title", value: "visible" },
    })
    expectAuthorized({
      kind: "sort",
      input: start("Proposal"),
      fields: [{ kind: "property", propertyId: "title" }],
    })
    expectAuthorized({
      kind: "text",
      input: start("Proposal"),
      query: "visible",
      fields: ["title"],
    })
    expectAuthorized({
      kind: "vector",
      input: start("LineItem"),
      propertyId: "embedding",
      vector: [1],
      k: 1,
    })
    expectAuthorized({ kind: "project", input: start("Proposal"), properties: ["title"] })
  })

  test("carries only result-producing set provenance", () => {
    const items = traverse("items", start("Proposal"))
    const reviewers = traverse("reviewers", start("Proposal"))

    expectAuthorized({
      kind: "traverse",
      linkId: "product",
      direction: "outgoing",
      input: { kind: "set", op: "union", inputs: [items, reviewers] },
    })
    expectAuthorized({
      kind: "traverse",
      linkId: "product",
      direction: "outgoing",
      input: { kind: "set", op: "intersect", inputs: [items, reviewers] },
    })
    expectDenied({
      kind: "traverse",
      linkId: "product",
      direction: "outgoing",
      input: { kind: "set", op: "subtract", inputs: [reviewers, items] },
    })
  })

  test("does not treat action subjects as object-view selections", () => {
    const actionOnly: RuntimeAccessPlan = { grants: [accessPlan.grants[1]!] }
    expect(() =>
      assertObjectQueryAuthorizedByAccessPlan(actionOnly, start("Proposal"), ontology)
    ).toThrow(AuthorizationError)
  })
})

function start(objectTypeId: string): ObjectQuery {
  return { kind: "start", objectTypeId }
}

function traverse(linkId: string, input: ObjectQuery): ObjectQuery {
  return { kind: "traverse", linkId, direction: "outgoing", input }
}

function expectAuthorized(query: ObjectQuery): void {
  expect(() => assertObjectQueryAuthorizedByAccessPlan(accessPlan, query, ontology)).not.toThrow()
}

function expectDenied(query: ObjectQuery): AuthorizationError {
  try {
    assertObjectQueryAuthorizedByAccessPlan(accessPlan, query, ontology)
  } catch (error) {
    expect(error).toBeInstanceOf(AuthorizationError)
    if (error instanceof AuthorizationError) return error
    throw error
  }
  throw new Error("Expected the query to be denied")
}
