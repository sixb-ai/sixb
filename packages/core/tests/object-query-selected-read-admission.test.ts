import { describe, expect, test } from "bun:test"
import { AuthorizationError } from "../src/authorization/errors"
import type { ObjectQuery } from "../src/objects/query/ir"
import { createSelectedObjectQueryAdmission } from "../src/objects/query/selected-read-admission"
import {
  type AdmittedObjectQuery,
  validateObjectQueryWithAdmission,
} from "../src/objects/query/validate"
import { defineObjectType, link, OntologyRegistry, prop } from "../src/ontology"
import { compileSelectedObjectReadScope } from "../src/storage/objects/read-scope"

const Product = defineObjectType({
  id: "Product",
  name: "Product",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      query: { searchable: true, text: true, filterable: true, sortable: true },
    }),
    prop("price", "double", {
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
  search: {
    defaultText: ["name"],
    vector: { property: "embedding", source: ["name"] },
  },
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

const Asset = defineObjectType({
  id: "Asset",
  name: "Asset",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("label", "string", {
      query: { searchable: true, text: true, filterable: true, sortable: true },
    }),
  ],
})

const SpecialAsset = defineObjectType({
  id: "SpecialAsset",
  name: "Special asset",
  extends: Asset,
  properties: [],
})

const Unselected = defineObjectType({
  id: "Unselected",
  name: "Unselected",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const ontology = new OntologyRegistry({
  sources: [Proposal, LineItem, Product, Asset, SpecialAsset, Unselected],
})

const admission = createSelectedObjectQueryAdmission(
  compileSelectedObjectReadScope({
    kind: "selected",
    roots: [
      {
        anchor: { objectTypeId: Proposal.id, primaryId: "proposal-1" },
        node: {
          objects: [{ objectTypeId: Proposal.id, propertyIds: ["id", "title"] }],
          links: [
            {
              definitions: [
                {
                  sourceObjectTypeId: Proposal.id,
                  linkId: "items",
                  targetObjectTypeIds: [LineItem.id],
                  propertyIds: ["position"],
                },
              ],
              target: {
                objects: [
                  {
                    objectTypeId: LineItem.id,
                    propertyIds: ["id", "name", "embedding"],
                  },
                ],
                links: [
                  {
                    definitions: [
                      {
                        sourceObjectTypeId: LineItem.id,
                        linkId: "product",
                        targetObjectTypeIds: [Product.id],
                        propertyIds: [],
                      },
                    ],
                    target: {
                      objects: [{ objectTypeId: Product.id, propertyIds: ["id", "name"] }],
                      links: [],
                    },
                  },
                ],
              },
            },
            {
              definitions: [
                {
                  sourceObjectTypeId: Proposal.id,
                  linkId: "reviewers",
                  targetObjectTypeIds: [LineItem.id],
                  propertyIds: [],
                },
              ],
              target: {
                objects: [
                  {
                    objectTypeId: LineItem.id,
                    propertyIds: ["id", "role"],
                  },
                ],
                links: [],
              },
            },
          ],
        },
      },
      {
        anchor: { objectTypeId: SpecialAsset.id, primaryId: "asset-1" },
        node: {
          objects: [{ objectTypeId: SpecialAsset.id, propertyIds: ["id", "label"] }],
          links: [],
        },
      },
    ],
  })
)

describe("selected object query admission", () => {
  test("admits sources by possible selected provenance while leaving exact refs to storage", () => {
    expectAuthorized({ kind: "start", objectTypeId: Proposal.id })
    expectAuthorized({
      kind: "refs",
      refs: [{ objectTypeId: Proposal.id, primaryId: "guessed-sibling" }],
    })
    expectAuthorized({ kind: "start", objectTypeId: Asset.id, includeSubtypes: true })

    expectDenied({ kind: "start", objectTypeId: Asset.id })
    expectDenied({
      kind: "refs",
      refs: [{ objectTypeId: Unselected.id, primaryId: "known-id" }],
    })
  })

  test("covers every predicate form in the canonical predicate walk", () => {
    const allowed = [
      { op: "eq", propertyId: "title", value: "A" },
      { op: "neq", propertyId: "title", value: "A" },
      { op: "lt", propertyId: "title", value: "A" },
      { op: "lte", propertyId: "title", value: "A" },
      { op: "gt", propertyId: "title", value: "A" },
      { op: "gte", propertyId: "title", value: "A" },
      { op: "in", propertyId: "title", values: ["A"] },
      { op: "exists", propertyId: "title", value: true },
      { op: "contains", propertyId: "title", value: "A" },
    ] as const

    for (const predicate of allowed) {
      expectAuthorized({ kind: "filter", input: start(Proposal.id), predicate })
    }

    expectDenied({
      kind: "filter",
      input: start(Proposal.id),
      predicate: {
        op: "and",
        items: [
          { op: "eq", propertyId: "title", value: "A" },
          {
            op: "or",
            items: [
              {
                op: "not",
                item: { op: "contains", propertyId: "secret", value: "hidden" },
              },
            ],
          },
        ],
      },
    })
  })

  test("authorizes text, vector, sort, and project properties in their existing validators", () => {
    expectAuthorized({
      kind: "text",
      input: start(Proposal.id),
      query: "visible",
      fields: ["title"],
    })
    expectDenied({ kind: "text", input: start(Proposal.id), query: "hidden" })
    expectDenied({
      kind: "text",
      input: start(Proposal.id),
      query: "hidden",
      fields: ["secret"],
    })

    expectAuthorized({
      kind: "vector",
      input: traverse("items", start(Proposal.id)),
      propertyId: "embedding",
      vector: [1],
      k: 1,
    })
    expectDenied({
      kind: "vector",
      input: start(LineItem.id),
      propertyId: "embedding",
      vector: [1],
      k: 1,
    })

    expectAuthorized({
      kind: "sort",
      input: start(Proposal.id),
      fields: [{ kind: "property", propertyId: "title" }],
    })
    expectAuthorized({
      kind: "sort",
      input: start(Proposal.id),
      fields: [{ kind: "relevance" }],
    })
    expectDenied({
      kind: "sort",
      input: start(Proposal.id),
      fields: [{ kind: "property", propertyId: "secret" }],
    })

    expectAuthorized({ kind: "project", input: start(Proposal.id) })
    expectAuthorized({ kind: "project", input: start(Proposal.id), properties: ["title"] })
    expectDenied({ kind: "project", input: start(Proposal.id), properties: ["secret"] })
  })

  test("requires a property on every possible occurrence instead of borrowing from a sibling path", () => {
    expectDenied({
      kind: "filter",
      input: start(LineItem.id),
      predicate: { op: "eq", propertyId: "name", value: "visible" },
    })
    expectAuthorized({
      kind: "filter",
      input: traverse("items", start(Proposal.id)),
      predicate: { op: "eq", propertyId: "name", value: "visible" },
    })
    expectAuthorized({
      kind: "filter",
      input: traverse("reviewers", start(Proposal.id)),
      predicate: { op: "eq", propertyId: "role", value: "approver" },
    })
  })

  test("preserves exact outgoing and incoming path provenance", () => {
    expectAuthorized(traverse("product", traverse("items", start(Proposal.id))))
    expectDenied(traverse("product", traverse("reviewers", start(Proposal.id))))

    expectAuthorized({
      kind: "traverse",
      linkId: "items",
      direction: "incoming",
      sourceObjectTypeId: Proposal.id,
      input: {
        kind: "traverse",
        linkId: "product",
        direction: "incoming",
        sourceObjectTypeId: LineItem.id,
        input: start(Product.id),
      },
    })
    expectDenied({
      kind: "traverse",
      linkId: "items",
      direction: "incoming",
      sourceObjectTypeId: Proposal.id,
      input: traverse("reviewers", start(Proposal.id)),
    })
  })

  test("fails closed when a compiled step disagrees with the ontology-resolved target", () => {
    const staleAdmission = createSelectedObjectQueryAdmission(
      compileSelectedObjectReadScope({
        kind: "selected",
        roots: [
          {
            anchor: { objectTypeId: Proposal.id, primaryId: "proposal-1" },
            node: {
              objects: [{ objectTypeId: Proposal.id, propertyIds: ["id"] }],
              links: [
                {
                  definitions: [
                    {
                      sourceObjectTypeId: Proposal.id,
                      linkId: "items",
                      targetObjectTypeIds: [Product.id],
                      propertyIds: [],
                    },
                  ],
                  target: {
                    objects: [{ objectTypeId: Product.id, propertyIds: ["id"] }],
                    links: [],
                  },
                },
              ],
            },
          },
        ],
      })
    )

    expect(() =>
      validateObjectQueryWithAdmission(
        traverse("items", start(Proposal.id)),
        { ontology },
        staleAdmission
      )
    ).toThrow(AuthorizationError)
  })

  test("uses the same edge and property hooks for nested expansions", () => {
    expectAuthorized({
      kind: "expand",
      input: start(Proposal.id),
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
      input: start(Proposal.id),
      expansions: [
        {
          linkId: "items",
          direction: "outgoing",
          expand: [
            {
              linkId: "product",
              direction: "outgoing",
              orderBy: [{ kind: "property", propertyId: "price" }],
            },
          ],
        },
      ],
    })
    expectDenied({
      kind: "expand",
      input: start(Proposal.id),
      expansions: [
        {
          linkId: "reviewers",
          direction: "outgoing",
          expand: [{ linkId: "product", direction: "outgoing" }],
        },
      ],
    })
  })

  test("carries result-producing provenance through every set operation", () => {
    const items = traverse("items", start(Proposal.id))
    const reviewers = traverse("reviewers", start(Proposal.id))

    expectAuthorized(traverse("product", { kind: "set", op: "union", inputs: [items, reviewers] }))
    expectAuthorized(
      traverse("product", { kind: "set", op: "intersect", inputs: [items, reviewers] })
    )
    expectDenied(traverse("product", { kind: "set", op: "subtract", inputs: [reviewers, items] }))
  })

  test("passes neutral limit/page nodes and exposes root state for terminal checks", () => {
    const validated = authorize({
      kind: "page",
      pageSize: 10,
      input: { kind: "limit", limit: 10, input: start(Proposal.id) },
    })

    expect(() =>
      admission.assertPropertySelected({
        state: validated.admissionState,
        propertyId: "title",
        use: "facet",
        path: "$.facets[0]",
      })
    ).not.toThrow()
    expect(() =>
      admission.assertPropertySelected({
        state: validated.admissionState,
        propertyId: "secret",
        use: "facet",
        path: "$.facets[0]",
      })
    ).toThrow(AuthorizationError)
    expect(() =>
      admission.assertIncidentEdgeSelected({
        state: validated.admissionState,
        linkId: "items",
        direction: "outgoing",
        path: "$.linkId",
      })
    ).not.toThrow()
    expect(() =>
      admission.assertIncidentEdgeSelected({
        state: validated.admissionState,
        linkId: "product",
        direction: "outgoing",
        path: "$.linkId",
      })
    ).toThrow(AuthorizationError)
    expect(() =>
      admission.assertIncidentEdgeSelected({
        state: validated.admissionState,
        direction: "both",
        path: "$.linkId",
      })
    ).not.toThrow()
    try {
      admission.assertIncidentEdgeSelected({
        state: validated.admissionState,
        linkId: "product",
        direction: "both",
        path: "$.linkId",
      })
      throw new Error("Expected both-direction link admission to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationError)
      if (!(error instanceof AuthorizationError)) throw error
      expect(error.grantKey).toBe("view:link:both:product")
      expect(error.message).toContain("both link 'product'")
    }
  })

  test("raises ordinary validation before a deferred admission denial", () => {
    expect(() =>
      authorize({
        kind: "filter",
        input: start(Proposal.id),
        predicate: { op: "eq", propertyId: "unknown", value: "x" },
      })
    ).toThrow("Object query validation failed")
  })
})

function start(objectTypeId: string): ObjectQuery {
  return { kind: "start", objectTypeId }
}

function traverse(linkId: string, input: ObjectQuery): ObjectQuery {
  return { kind: "traverse", linkId, direction: "outgoing", input }
}

function authorize(query: ObjectQuery): AdmittedObjectQuery {
  return validateObjectQueryWithAdmission(query, { ontology }, admission)
}

function expectAuthorized(query: ObjectQuery): void {
  expect(() => authorize(query)).not.toThrow()
}

function expectDenied(query: ObjectQuery): AuthorizationError {
  try {
    authorize(query)
  } catch (error) {
    expect(error).toBeInstanceOf(AuthorizationError)
    if (error instanceof AuthorizationError) return error
    throw error
  }
  throw new Error("Expected the selected query admission to deny the query")
}
