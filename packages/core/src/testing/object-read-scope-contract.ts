import { describe, expect, test } from "bun:test"
import type { JsonValue } from "../json"
import { executeObjectQuery, type ObjectQuery } from "../objects/query"
import { defineObjectType, link, OntologyRegistry, prop } from "../ontology"
import {
  compileSelectedObjectReadScope,
  linkBatchKey,
  MAX_OBJECT_READ_FACETS,
  type ObjectReadExecutionLimits,
  type ObjectReadScopeFactory,
  type ObjectReadStorage,
  objectBatchKey,
  type SelectedObjectReadScope,
} from "../storage/objects"
import type { Storage } from "../storage/types"
import {
  createMaterializerTestFixture,
  type MaterializerFixtureLink,
  type MaterializerFixtureObject,
  type MaterializerTestFixture,
} from "./materializer-fixture"

export interface ObjectReadScopeContractHarness<TStorage extends Storage> {
  readonly storage: TStorage
  /** Kept separate from `storage.objects` until the effective Storage contract activates it. */
  readonly objectReadScopeFactory: ObjectReadScopeFactory
}

export interface ObjectReadScopeContractSuiteOptions<TStorage extends Storage> {
  readonly createHarness: () =>
    | ObjectReadScopeContractHarness<TStorage>
    | Promise<ObjectReadScopeContractHarness<TStorage>>
  readonly teardown?: (harness: ObjectReadScopeContractHarness<TStorage>) => void | Promise<void>
}

const projectId = "object-read-scope-contract"
const otherProjectId = "object-read-scope-contract-other"
const Product = defineObjectType({
  id: "ScopeProduct",
  name: "Scope Product",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { query: { searchable: true, text: true } }),
    prop("internal", "string"),
  ],
  search: { defaultText: ["name"] },
})

const LineItem = defineObjectType({
  id: "ScopeLineItem",
  name: "Scope Line Item",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { query: { searchable: true, text: true, sortable: true } }),
    prop("price", "double", { query: { searchable: true, filterable: true, sortable: true } }),
    prop("reviewNote", "string"),
    prop("internal", "string"),
  ],
  links: [link("product", Product, { cardinality: "one" })],
  search: { defaultText: ["name"] },
})

const Proposal = defineObjectType({
  id: "ScopeProposal",
  name: "Scope Proposal",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", {
      query: { searchable: true, text: true, filterable: true, sortable: true },
    }),
    prop("rank", "double", { query: { searchable: true, filterable: true, sortable: true } }),
    prop("category", "string", { query: { searchable: true, filterable: true, facet: true } }),
    prop(
      "embedding",
      { type: "array", items: "double" },
      { query: { searchable: true, vector: true } }
    ),
    prop("secret", "string", { query: { searchable: true, filterable: true, facet: true } }),
  ],
  links: [
    link("items", LineItem, {
      properties: [prop("position", "double"), prop("label", "string"), prop("internal", "string")],
    }),
    link("reviewers", LineItem),
    link.self("related"),
    link("aPrivate", Product),
    link("zVisible", Product),
  ],
  search: { defaultText: ["title"] },
})

export const objectReadScopeContractOntology = new OntologyRegistry({
  sources: [Proposal, LineItem, Product],
})

const limits: ObjectReadExecutionLimits = {
  maxTraversalFacts: 100,
  maxOutputJsonBytes: 1_000_000,
}

/**
 * Portable selected-object-read contract shared by every storage provider.
 *
 * It verifies the security boundary, not a provider's implementation strategy: selection is live,
 * path-sensitive, applied before every terminal, redacted, project-bound, and independently
 * budgeted.
 */
export function runObjectReadScopeContractSuite<TStorage extends Storage>(
  label: string,
  options: ObjectReadScopeContractSuiteOptions<TStorage>
): void {
  const withHarness = async (
    body: (context: {
      readonly harness: ObjectReadScopeContractHarness<TStorage>
      readonly fixture: MaterializerTestFixture
    }) => Promise<void>
  ): Promise<void> => {
    const harness = await options.createHarness()
    try {
      const fixture = createMaterializerTestFixture({
        projectId,
        ontology: objectReadScopeContractOntology,
        storage: harness.storage,
      })
      await seed(fixture)
      await body({ harness, fixture })
    } finally {
      await options.teardown?.(harness)
    }
  }

  describe(label, () => {
    test("selects exact live identities, unions properties, and redacts detached rows", async () => {
      await withHarness(async ({ harness, fixture }) => {
        const reader = createReader(harness.objectReadScopeFactory)

        const proposal = await reader.getByPrimaryId({
          projectId,
          objectTypeId: Proposal.id,
          primaryId: "proposal-1",
        })
        expect(proposal?.primaryId).toBe("proposal-1")
        expect(proposal?.properties).toEqual({
          id: "proposal-1",
          title: "Visible proposal",
          rank: 50,
          category: "visible",
          embedding: [0, 1],
        })
        expect(proposal?.links).toBeUndefined()
        expect(
          await reader.getByPrimaryId({
            projectId,
            objectTypeId: Proposal.id,
            primaryId: "proposal-2",
          })
        ).toBeNull()

        const item = await reader.getByPrimaryId({
          projectId,
          objectTypeId: LineItem.id,
          primaryId: "item:opaque|1",
        })
        expect(item?.properties).toEqual({
          id: "item:opaque|1",
          name: "Visible item",
          reviewNote: "Property union",
        })
        expect(
          await reader.selectsObjectProperties({
            projectId,
            items: [
              { objectTypeId: LineItem.id, primaryId: "item:opaque|1", propertyId: "price" },
              { objectTypeId: LineItem.id, primaryId: "item:opaque|1", propertyId: "price" },
              { objectTypeId: LineItem.id, primaryId: "item:opaque|1", propertyId: "secret" },
              { objectTypeId: LineItem.id, primaryId: "item-hidden", propertyId: "id" },
            ],
          })
        ).toEqual([true, true, false, false])

        const listed = await reader.list({
          projectId,
          objectTypeId: LineItem.id,
          limit: 1,
          orderBy: "primaryId",
          order: "asc",
        })
        expect(listed).toMatchObject({ total: 2, hasMore: true })
        expect(listed.objects).toHaveLength(1)
        expect(listed.objects[0]?.primaryId).toBe("item:opaque|1")
        expect(listed.objects[0]?.properties).toEqual({
          id: "item:opaque|1",
          name: "Visible item",
          reviewNote: "Property union",
        })
        expect(listed.objects[0]?.links).toBeUndefined()

        if (!item) throw new Error("expected a selected item")
        item.properties.name = "mutated outside provider"
        expect(
          (
            await reader.getByPrimaryId({
              projectId,
              objectTypeId: LineItem.id,
              primaryId: "item:opaque|1",
            })
          )?.properties
        ).toEqual({ id: "item:opaque|1", name: "Visible item", reviewNote: "Property union" })

        await fixture.seed({
          objects: [object(LineItem.id, "item-live", { id: "item-live", name: "Added later" })],
          links: [linkRow(Proposal.id, "proposal-1", "items", LineItem.id, "item-live")],
        })
        expect(
          (
            await reader.getByPrimaryId({
              projectId,
              objectTypeId: LineItem.id,
              primaryId: "item-live",
            })
          )?.properties
        ).toEqual({ id: "item-live", name: "Added later" })

        await fixture.commit([
          {
            id: "delete-live-link",
            kind: "link.delete",
            ref: linkRow(Proposal.id, "proposal-1", "items", LineItem.id, "item-live").ref,
          },
        ])
        expect(
          await reader.getByPrimaryId({
            projectId,
            objectTypeId: LineItem.id,
            primaryId: "item-live",
          })
        ).toBeNull()
      })
    })

    test("supports an empty selection and rejects every cross-project call", async () => {
      await withHarness(async ({ harness }) => {
        const empty = createReader(harness.objectReadScopeFactory, {
          kind: "selected",
          roots: [],
        })
        expect((await empty.list({ projectId })).total).toBe(0)
        expect(
          await empty.queryObjects?.({
            projectId,
            query: { kind: "start", objectTypeId: Proposal.id },
          })
        ).toMatchObject({ objects: [], total: 0 })

        const reader = createReader(harness.objectReadScopeFactory)
        const queryObjects = reader.queryObjects?.bind(reader)
        const countObjects = reader.countObjects?.bind(reader)
        const existsObjects = reader.existsObjects?.bind(reader)
        const facetObjects = reader.facetObjects?.bind(reader)
        if (!queryObjects || !countObjects || !existsObjects || !facetObjects) {
          throw new Error("Selected object-read scope contract requires every query terminal.")
        }
        const crossProjectCalls: readonly (() => Promise<unknown>)[] = [
          () =>
            queryObjects({
              projectId: otherProjectId,
              query: { kind: "start", objectTypeId: Proposal.id },
            }),
          () =>
            countObjects({
              projectId: otherProjectId,
              query: { kind: "start", objectTypeId: Proposal.id },
            }),
          () =>
            existsObjects({
              projectId: otherProjectId,
              query: { kind: "start", objectTypeId: Proposal.id },
            }),
          () =>
            facetObjects({
              projectId: otherProjectId,
              query: { kind: "start", objectTypeId: Proposal.id },
              facets: [{ propertyId: "category", limit: 1 }],
            }),
          () =>
            reader.getByPrimaryId({
              projectId: otherProjectId,
              objectTypeId: Proposal.id,
              primaryId: "proposal-1",
            }),
          () =>
            reader.selectsObjectProperties({
              projectId: otherProjectId,
              items: [{ objectTypeId: Proposal.id, primaryId: "proposal-1", propertyId: "id" }],
            }),
          () =>
            reader.listLinks({
              projectId: otherProjectId,
              objectTypeId: Proposal.id,
              objectId: "proposal-1",
            }),
          () =>
            reader.getByPrimaryIdBatch({
              projectId: otherProjectId,
              items: [{ objectTypeId: Proposal.id, primaryId: "proposal-1" }],
            }),
          () =>
            reader.listLinksBatch({
              projectId: otherProjectId,
              items: [{ objectTypeId: Proposal.id, objectId: "proposal-1", linkId: "items" }],
            }),
          () =>
            reader.queryLinks({
              projectId: otherProjectId,
              objectRefs: [{ objectTypeId: Proposal.id, primaryId: "proposal-1" }],
              direction: "outgoing",
              limit: 1,
            }),
          () => reader.list({ projectId: otherProjectId }),
        ]

        for (const call of crossProjectCalls) {
          await expect(call()).rejects.toThrow(`belongs to project '${projectId}'`)
        }
      })
    })

    test("makes every selected target invisible as soon as its root is deleted", async () => {
      await withHarness(async ({ harness, fixture }) => {
        const reader = createReader(harness.objectReadScopeFactory)
        await fixture.commit([
          {
            id: "delete-selected-root",
            kind: "object.delete",
            ref: { objectTypeId: Proposal.id, primaryId: "proposal-1" },
          },
        ])

        for (const ref of [
          { objectTypeId: Proposal.id, primaryId: "proposal-1" },
          { objectTypeId: LineItem.id, primaryId: "item:opaque|1" },
          { objectTypeId: LineItem.id, primaryId: "reviewer-1" },
          { objectTypeId: Product.id, primaryId: "product-1" },
        ]) {
          expect(await reader.getByPrimaryId({ projectId, ...ref })).toBeNull()
        }

        expect(await reader.list({ projectId })).toEqual({ objects: [], hasMore: false, total: 0 })
        expect(
          await reader.queryObjects?.({
            projectId,
            query: { kind: "start", objectTypeId: LineItem.id },
          })
        ).toMatchObject({ objects: [], total: 0 })
        expect(
          await reader.listLinks({
            projectId,
            objectTypeId: Proposal.id,
            objectId: "proposal-1",
          })
        ).toEqual([])
        expect(
          await reader.queryLinks({
            projectId,
            objectRefs: [{ objectTypeId: Proposal.id, primaryId: "proposal-1" }],
            direction: "outgoing",
            limit: 10,
          })
        ).toEqual({ links: [], hasMore: false })
      })
    })

    test("uses collision-safe batch keys and exact incoming, outgoing, and self-loop semantics", async () => {
      await withHarness(async ({ harness }) => {
        const reader = createReader(harness.objectReadScopeFactory)
        const objects = await reader.getByPrimaryIdBatch({
          projectId,
          items: [
            { objectTypeId: Proposal.id, primaryId: "proposal-1" },
            { objectTypeId: LineItem.id, primaryId: "item:opaque|1" },
            { objectTypeId: Proposal.id, primaryId: "proposal-2" },
          ],
        })
        expect([...objects.keys()]).toEqual([
          objectBatchKey(Proposal.id, "proposal-1"),
          objectBatchKey(LineItem.id, "item:opaque|1"),
        ])
        expect(objects.get(objectBatchKey(Proposal.id, "proposal-1"))?.properties).toEqual({
          id: "proposal-1",
          title: "Visible proposal",
          rank: 50,
          category: "visible",
          embedding: [0, 1],
        })
        expect(objects.get(objectBatchKey(Proposal.id, "proposal-1"))?.links).toBeUndefined()
        expect(objects.get(objectBatchKey(LineItem.id, "item:opaque|1"))?.properties).toEqual({
          id: "item:opaque|1",
          name: "Visible item",
          reviewNote: "Property union",
        })
        expect(objects.get(objectBatchKey(LineItem.id, "item:opaque|1"))?.links).toBeUndefined()

        const outgoing = await reader.listLinksBatch({
          projectId,
          direction: "outgoing",
          items: [{ objectTypeId: Proposal.id, objectId: "proposal-1", linkId: "items" }],
        })
        const outgoingRows = outgoing.get(linkBatchKey(Proposal.id, "proposal-1", "items"))
        expect(outgoingRows).toHaveLength(1)
        expect(outgoingRows?.[0]?.targetId).toBe("item:opaque|1")
        expect(outgoingRows?.[0]?.properties).toEqual({ position: 1, label: "primary" })

        const listedLinks = await reader.listLinks({
          projectId,
          objectTypeId: Proposal.id,
          objectId: "proposal-1",
          linkId: "items",
        })
        expect(listedLinks).toHaveLength(1)
        expect(listedLinks[0]?.targetId).toBe("item:opaque|1")
        expect(listedLinks[0]?.properties).toEqual({ position: 1, label: "primary" })

        const queriedLinks = await reader.queryLinks({
          projectId,
          objectRefs: [{ objectTypeId: Proposal.id, primaryId: "proposal-1" }],
          direction: "outgoing",
          linkId: "items",
          limit: 10,
        })
        expect(queriedLinks.links).toHaveLength(1)
        expect(queriedLinks.links[0]?.targetId).toBe("item:opaque|1")
        expect(queriedLinks.links[0]?.properties).toEqual({ position: 1, label: "primary" })

        const incoming = await reader.listLinksBatch({
          projectId,
          direction: "incoming",
          items: [{ objectTypeId: LineItem.id, objectId: "item:opaque|1", linkId: "items" }],
        })
        const incomingRows = incoming.get(linkBatchKey(LineItem.id, "item:opaque|1", "items"))
        expect(incomingRows).toHaveLength(1)
        expect(incomingRows?.[0]?.properties).toEqual({ position: 1, label: "primary" })
        expect(incoming.has(linkBatchKey(Proposal.id, "proposal-1", "items"))).toBe(false)

        const selfLoop = await reader.listLinksBatch({
          projectId,
          direction: "both",
          items: [{ objectTypeId: Proposal.id, objectId: "proposal-1", linkId: "related" }],
        })
        expect(selfLoop.get(linkBatchKey(Proposal.id, "proposal-1", "related"))).toHaveLength(1)
      })
    })

    test("applies scope before query ordering, pagination, predicates, and aggregate terminals", async () => {
      await withHarness(async ({ harness }) => {
        const reader = createReader(harness.objectReadScopeFactory)
        const query = async (value: ObjectQuery) =>
          reader.queryObjects?.({ projectId, query: value })

        const queriedProposal = await query({ kind: "start", objectTypeId: Proposal.id })
        expect(queriedProposal?.objects.map((row) => row.primaryId)).toEqual(["proposal-1"])
        expect(queriedProposal?.objects[0]?.properties).toEqual({
          id: "proposal-1",
          title: "Visible proposal",
          rank: 50,
          category: "visible",
          embedding: [0, 1],
        })
        expect(queriedProposal?.objects[0]?.links).toBeUndefined()
        expect(
          (
            await query({
              kind: "refs",
              refs: [
                { objectTypeId: Proposal.id, primaryId: "proposal-2" },
                { objectTypeId: Proposal.id, primaryId: "proposal-1" },
                { objectTypeId: LineItem.id, primaryId: "item:opaque|1" },
              ],
            })
          )?.objects.map((row) => `${row.objectTypeId}:${row.primaryId}`)
        ).toEqual([`${LineItem.id}:item:opaque|1`, `${Proposal.id}:proposal-1`])
        expect(
          (
            await query({
              kind: "filter",
              input: { kind: "start", objectTypeId: Proposal.id },
              predicate: { op: "eq", propertyId: "secret", value: "root-secret" },
            })
          )?.objects
        ).toEqual([])
        expect(
          (
            await query({
              kind: "limit",
              limit: 1,
              input: {
                kind: "sort",
                fields: [{ kind: "property", propertyId: "rank", direction: "asc" }],
                input: { kind: "start", objectTypeId: Proposal.id },
              },
            })
          )?.objects.map((row) => row.primaryId)
        ).toEqual(["proposal-1"])
        expect(
          (
            await query({
              kind: "text",
              input: { kind: "start", objectTypeId: Proposal.id },
              query: "visible",
              fields: ["title"],
            })
          )?.objects.map((row) => row.primaryId)
        ).toEqual(["proposal-1"])
        expect(
          (
            await query({
              kind: "set",
              op: "union",
              inputs: [
                { kind: "start", objectTypeId: Proposal.id },
                { kind: "start", objectTypeId: Product.id },
              ],
            })
          )?.objects.map((row) => row.primaryId)
        ).toEqual(expect.arrayContaining(["proposal-1", "product-1"]))

        const firstPage = await query({
          kind: "page",
          pageSize: 1,
          input: {
            kind: "sort",
            fields: [{ kind: "property", propertyId: "id", direction: "asc" }],
            input: { kind: "start", objectTypeId: LineItem.id },
          },
        })
        expect(firstPage).toMatchObject({
          hasMore: true,
          objects: [{ primaryId: "item:opaque|1" }],
        })
        expect(firstPage?.nextPageToken).toBeString()
        const secondPage = await query({
          kind: "page",
          pageSize: 1,
          pageToken: firstPage?.nextPageToken,
          input: {
            kind: "sort",
            fields: [{ kind: "property", propertyId: "id", direction: "asc" }],
            input: { kind: "start", objectTypeId: LineItem.id },
          },
        })
        expect(secondPage).toMatchObject({
          hasMore: false,
          objects: [{ primaryId: "reviewer-1" }],
        })
        expect(secondPage?.objects[0]?.properties).toEqual({
          id: "reviewer-1",
          reviewNote: "selected",
        })
        expect(secondPage?.objects[0]?.links).toBeUndefined()

        expect(
          await reader.countObjects?.({
            projectId,
            query: { kind: "start", objectTypeId: Proposal.id },
          })
        ).toEqual({ count: 1 })
        expect(
          await reader.existsObjects?.({
            projectId,
            query: {
              kind: "filter",
              input: { kind: "start", objectTypeId: Proposal.id },
              predicate: { op: "eq", propertyId: "secret", value: "root-secret" },
            },
          })
        ).toEqual({ exists: false })
        expect(
          await reader.facetObjects?.({
            projectId,
            query: { kind: "start", objectTypeId: Proposal.id },
            facets: [
              { propertyId: "category", limit: 10 },
              { propertyId: "secret", limit: 10 },
            ],
          })
        ).toEqual({
          facets: [
            { propertyId: "category", buckets: [{ value: "visible", count: 1 }] },
            { propertyId: "secret", buckets: [] },
          ],
        })
      })
    })

    test("preserves path provenance through traverse and nested expand", async () => {
      await withHarness(async ({ harness }) => {
        const reader = createReader(harness.objectReadScopeFactory)
        const traversed = await reader.queryObjects?.({
          projectId,
          query: {
            kind: "traverse",
            direction: "outgoing",
            linkId: "product",
            input: { kind: "start", objectTypeId: LineItem.id },
          },
        })
        expect(traversed?.objects.map((row) => row.primaryId)).toEqual(["product-1"])
        expect(traversed?.objects[0]?.properties).toEqual({
          id: "product-1",
          name: "Visible product",
        })
        expect(traversed?.objects[0]?.links).toBeUndefined()
        expect(
          await reader.getByPrimaryId({
            projectId,
            objectTypeId: Product.id,
            primaryId: "product-review",
          })
        ).toBeNull()

        const expanded = await executeObjectQuery(
          {
            projectId,
            query: {
              kind: "expand",
              input: {
                kind: "limit",
                limit: 10,
                input: { kind: "start", objectTypeId: Proposal.id },
              },
              expansions: [
                {
                  linkId: "items",
                  direction: "outgoing",
                  expand: [{ linkId: "product", direction: "outgoing" }],
                },
              ],
            },
          },
          { ontology: objectReadScopeContractOntology, storage: reader }
        )
        const items = expanded.objects[0]?.links?.items
        expect(Array.isArray(items)).toBe(true)
        if (!Array.isArray(items)) throw new Error("expected expanded items")
        expect(items[0]?.linkProperties).toEqual({ position: 1, label: "primary" })
        const expandedProduct = items[0]?.links?.product
        expect(expandedProduct).toMatchObject({ primaryId: "product-1" })
        if (!expandedProduct || Array.isArray(expandedProduct)) {
          throw new Error("expected one expanded product")
        }
        expect(expandedProduct.properties).toEqual({
          id: "product-1",
          name: "Visible product",
        })
        expect(expandedProduct.links).toBeUndefined()
      })
    })

    test("filters unauthorized links and endpoints before canonical link pagination", async () => {
      await withHarness(async ({ harness }) => {
        const reader = createReader(harness.objectReadScopeFactory, visibleLinkScope())
        expect(
          await reader.queryLinks({
            projectId,
            objectRefs: [{ objectTypeId: Proposal.id, primaryId: "proposal-1" }],
            direction: "outgoing",
            limit: 1,
          })
        ).toMatchObject({ links: [{ linkId: "zVisible" }], hasMore: false })
        expect(
          await reader.queryLinks({
            projectId,
            objectRefs: [{ objectTypeId: Proposal.id, primaryId: "proposal-1" }],
            direction: "outgoing",
            endpointObjectTypeIds: [Proposal.id],
            limit: 1,
          })
        ).toEqual({ links: [], hasMore: false })
      })
    })

    test("enforces facet, traversal, and complete batch-output budgets independently", async () => {
      await withHarness(async ({ harness }) => {
        const traversalBound = createReader(harness.objectReadScopeFactory, proposalScope(), {
          ...limits,
          maxTraversalFacts: 1,
        })
        await expect(traversalBound.list({ projectId })).rejects.toMatchObject({
          code: "object_read_limit_exceeded",
          metric: "traversalFacts",
          limit: 1,
        })

        const tinyOutput = createReader(harness.objectReadScopeFactory, proposalScope(), {
          ...limits,
          maxOutputJsonBytes: 8,
        })
        await expect(
          tinyOutput.getByPrimaryIdBatch({
            projectId,
            items: [{ objectTypeId: LineItem.id, primaryId: "item:opaque|1" }],
          })
        ).rejects.toMatchObject({
          code: "object_read_limit_exceeded",
          metric: "outputJsonBytes",
          limit: 8,
        })

        const facetBound = createReader(harness.objectReadScopeFactory, proposalScope(), {
          ...limits,
          maxTraversalFacts: 1,
        })
        await expect(
          facetBound.facetObjects?.({
            projectId,
            query: { kind: "start", objectTypeId: Proposal.id },
            facets: Array.from({ length: MAX_OBJECT_READ_FACETS + 1 }, (_, index) => ({
              propertyId: `facet-${index}`,
              limit: 1,
            })),
          })
        ).rejects.toThrow(`between 0 and ${MAX_OBJECT_READ_FACETS} facets`)
      })
    })
  })
}

function createReader(
  factory: ObjectReadScopeFactory,
  scope: SelectedObjectReadScope = proposalScope(),
  executionLimits: ObjectReadExecutionLimits = limits
): ObjectReadStorage {
  return factory.createSelectedReadScope({
    projectId,
    scope: compileSelectedObjectReadScope(scope),
    limits: executionLimits,
  })
}

function proposalScope(): SelectedObjectReadScope {
  return {
    kind: "selected",
    roots: [
      {
        anchor: { objectTypeId: Proposal.id, primaryId: "proposal-1" },
        node: {
          objects: [
            {
              objectTypeId: Proposal.id,
              propertyIds: ["id", "title", "rank", "category", "embedding"],
            },
          ],
          links: [
            {
              definitions: [
                {
                  sourceObjectTypeId: Proposal.id,
                  linkId: "items",
                  targetObjectTypeIds: [LineItem.id],
                  propertyIds: ["position"],
                },
                {
                  sourceObjectTypeId: Proposal.id,
                  linkId: "items",
                  targetObjectTypeIds: [LineItem.id],
                  propertyIds: ["label", "position"],
                },
              ],
              target: {
                objects: [{ objectTypeId: LineItem.id, propertyIds: ["id", "name", "price"] }],
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
                objects: [{ objectTypeId: LineItem.id, propertyIds: ["id", "reviewNote"] }],
                links: [],
              },
            },
            {
              definitions: [
                {
                  sourceObjectTypeId: Proposal.id,
                  linkId: "related",
                  targetObjectTypeIds: [Proposal.id],
                  propertyIds: [],
                },
              ],
              target: {
                objects: [{ objectTypeId: Proposal.id, propertyIds: ["id", "title"] }],
                links: [],
              },
            },
          ],
        },
      },
    ],
  }
}

function visibleLinkScope(): SelectedObjectReadScope {
  return {
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
                  linkId: "zVisible",
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
  }
}

async function seed(fixture: MaterializerTestFixture): Promise<void> {
  await fixture.seed({
    objects: [
      object(Proposal.id, "proposal-1", {
        id: "proposal-1",
        title: "Visible proposal",
        rank: 50,
        category: "visible",
        embedding: [0, 1],
        secret: "root-secret",
      }),
      object(Proposal.id, "proposal-2", {
        id: "proposal-2",
        title: "Hidden proposal",
        rank: 1,
        category: "hidden",
        embedding: [1, 0],
        secret: "hidden-secret",
      }),
      object(LineItem.id, "item:opaque|1", {
        id: "item:opaque|1",
        name: "Visible item",
        reviewNote: "Property union",
        internal: "hidden",
      }),
      object(LineItem.id, "item-hidden", { id: "item-hidden", name: "Hidden item" }),
      object(LineItem.id, "reviewer-1", {
        id: "reviewer-1",
        name: "Visible reviewer",
        reviewNote: "selected",
      }),
      object(Product.id, "product-1", {
        id: "product-1",
        name: "Visible product",
        internal: "hidden",
      }),
      object(Product.id, "product-review", {
        id: "product-review",
        name: "Product outside selected path",
      }),
    ],
    links: [
      linkRow(Proposal.id, "proposal-1", "items", LineItem.id, "item:opaque|1", {
        position: 1,
        label: "primary",
        internal: "hidden",
      }),
      linkRow(Proposal.id, "proposal-2", "items", LineItem.id, "item-hidden"),
      linkRow(Proposal.id, "proposal-1", "reviewers", LineItem.id, "item:opaque|1"),
      linkRow(Proposal.id, "proposal-1", "reviewers", LineItem.id, "reviewer-1"),
      linkRow(Proposal.id, "proposal-1", "related", Proposal.id, "proposal-1"),
      linkRow(LineItem.id, "item:opaque|1", "product", Product.id, "product-1"),
      linkRow(LineItem.id, "reviewer-1", "product", Product.id, "product-review"),
      linkRow(Proposal.id, "proposal-1", "aPrivate", Product.id, "product-review"),
      linkRow(Proposal.id, "proposal-1", "zVisible", Product.id, "product-1"),
    ],
  })
}

function object(
  objectTypeId: string,
  primaryId: string,
  properties: Readonly<Record<string, JsonValue>>
): MaterializerFixtureObject {
  return {
    ref: { objectTypeId, primaryId },
    properties,
  }
}

function linkRow(
  sourceObjectTypeId: string,
  sourcePrimaryId: string,
  linkId: string,
  targetObjectTypeId: string,
  targetPrimaryId: string,
  properties?: Readonly<Record<string, JsonValue>>
): MaterializerFixtureLink {
  return {
    ref: {
      source: { objectTypeId: sourceObjectTypeId, primaryId: sourcePrimaryId },
      linkId,
      target: { objectTypeId: targetObjectTypeId, primaryId: targetPrimaryId },
    },
    ...(properties === undefined ? {} : { properties }),
  }
}
