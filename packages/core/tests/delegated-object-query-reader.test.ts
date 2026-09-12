import { expect, test } from "bun:test"
import { createAuthorizedObjectReader } from "../src/execution/authorized-object-reader"
import { createDelegatedRequestScope } from "../src/execution/scopes"
import { InMemoryStorage } from "../src/storage/in-memory"
import { createMaterializerTestFixture, objectReadScopeContractOntology } from "../src/testing"

const projectId = "delegated-object-query-reader"
const Proposal = "ScopeProposal"
const LineItem = "ScopeLineItem"

test("delegated object-query terminals never reveal a guessed sibling outside the selected graph", async () => {
  const storage = new InMemoryStorage()
  const fixture = createMaterializerTestFixture({
    projectId,
    ontology: objectReadScopeContractOntology,
    storage,
  })
  await fixture.seed({
    objects: [
      {
        ref: { objectTypeId: Proposal, primaryId: "proposal-1" },
        properties: {
          id: "proposal-1",
          title: "Selected proposal",
          category: "selected",
        },
      },
      {
        ref: { objectTypeId: Proposal, primaryId: "proposal-2" },
        properties: {
          id: "proposal-2",
          title: "Guessed sibling",
          category: "hidden",
        },
      },
      {
        ref: { objectTypeId: LineItem, primaryId: "item-1" },
        properties: { id: "item-1", name: "Selected item" },
      },
      {
        ref: { objectTypeId: LineItem, primaryId: "item-2" },
        properties: { id: "item-2", name: "Hidden item" },
      },
    ],
    links: [
      {
        ref: {
          source: { objectTypeId: Proposal, primaryId: "proposal-1" },
          linkId: "items",
          target: { objectTypeId: LineItem, primaryId: "item-1" },
        },
        properties: { position: 1 },
      },
      {
        ref: {
          source: { objectTypeId: Proposal, primaryId: "proposal-2" },
          linkId: "items",
          target: { objectTypeId: LineItem, primaryId: "item-2" },
        },
        properties: { position: 2 },
      },
    ],
  })

  const scope = createDelegatedRequestScope({
    projectId,
    requestId: "request-1",
    correlationId: "correlation-1",
    objectRead: {
      selection: {
        kind: "selected",
        roots: [
          {
            anchor: { objectTypeId: Proposal, primaryId: "proposal-1" },
            node: {
              objects: [
                {
                  objectTypeId: Proposal,
                  propertyIds: ["id", "title", "category"],
                },
              ],
              links: [
                {
                  definitions: [
                    {
                      sourceObjectTypeId: Proposal,
                      linkId: "items",
                      targetObjectTypeIds: [LineItem],
                      propertyIds: ["position"],
                    },
                  ],
                  target: {
                    objects: [{ objectTypeId: LineItem, propertyIds: ["id", "name"] }],
                    links: [],
                  },
                },
              ],
            },
          },
        ],
      },
      limits: { maxTraversalFacts: 100, maxOutputJsonBytes: 100_000 },
    },
  })
  const reader = createAuthorizedObjectReader({
    scope,
    ontology: objectReadScopeContractOntology,
    objectStorage: storage.objects,
  })
  const selectedQuery = {
    kind: "refs" as const,
    refs: [{ objectTypeId: Proposal, primaryId: "proposal-1" }],
  }
  const guessedSiblingQuery = {
    kind: "refs" as const,
    refs: [{ objectTypeId: Proposal, primaryId: "proposal-2" }],
  }

  expect(
    (await reader.executeQuery({ query: selectedQuery })).objects.map((row) => row.primaryId)
  ).toEqual(["proposal-1"])
  expect(await reader.count({ query: selectedQuery })).toMatchObject({ count: 1 })
  expect(await reader.exists({ query: selectedQuery })).toMatchObject({ exists: true })
  expect(
    (await reader.facet({ query: selectedQuery, facets: [{ propertyId: "category", limit: 10 }] }))
      .facets
  ).toEqual([{ propertyId: "category", buckets: [{ value: "selected", count: 1 }] }])
  const selectedLinks = await reader.queryLinks({
    query: selectedQuery,
    direction: "outgoing",
    linkId: "items",
    includeObjects: true,
  })
  expect(selectedLinks.links.map((link) => `${link.sourceId}->${link.targetId}`)).toEqual([
    "proposal-1->item-1",
  ])
  expect(selectedLinks.objects.map((row) => `${row.objectTypeId}:${row.primaryId}`).sort()).toEqual(
    [`${LineItem}:item-1`, `${Proposal}:proposal-1`].sort()
  )

  expect((await reader.executeQuery({ query: guessedSiblingQuery })).objects).toEqual([])
  expect(await reader.count({ query: guessedSiblingQuery })).toMatchObject({ count: 0 })
  expect(await reader.exists({ query: guessedSiblingQuery })).toMatchObject({ exists: false })
  expect(
    (
      await reader.facet({
        query: guessedSiblingQuery,
        facets: [{ propertyId: "category", limit: 10 }],
      })
    ).facets
  ).toEqual([{ propertyId: "category", buckets: [] }])
  expect(
    await reader.queryLinks({
      query: guessedSiblingQuery,
      direction: "outgoing",
      linkId: "items",
      includeObjects: true,
    })
  ).toEqual({ objects: [], links: [], hasMore: false })
})
