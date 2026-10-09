import { expect, test } from "bun:test"
import { defineObjectType, prop } from "../src"
import { createAuthorizedObjectReader } from "../src/execution/authorized-object-reader"
import { createDelegatedRequestScope } from "../src/execution/scopes"
import { OntologyRegistry } from "../src/ontology"
import type { ObjectStorage, QueryObjectsInput } from "../src/storage"
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

test("delegated default text search never sends an unselected field to the provider", async () => {
  // Reproduce: make the reader's executor admission return only the clearance admission. The
  // executor then re-resolves default text fields without the selection and sends `body`.
  const Note = defineObjectType({
    id: "ScopeNote",
    name: "Scope Note",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("title", "string", { query: { searchable: true, text: true } }),
      prop("body", "string", { query: { searchable: true, text: true } }),
    ],
    search: { defaultText: ["title", "body"] },
  })
  const ontology = new OntologyRegistry({ sources: [Note] })
  const storage = new InMemoryStorage()
  await createMaterializerTestFixture({ projectId, ontology, storage }).seed({
    objects: [
      {
        ref: { objectTypeId: Note.id, primaryId: "note-1" },
        properties: { id: "note-1", title: "Visible title", body: "unselected-word" },
      },
    ],
  })
  // The in-memory provider also hides unselected values from text matching, so observe the query
  // the reader sends instead of relying on that second line of defense.
  const providerQueries: unknown[] = []
  const objectStorage: ObjectStorage = Object.create(storage.objects, {
    createSelectedReadScope: {
      value: (params: Parameters<ObjectStorage["createSelectedReadScope"]>[0]) => {
        const selected = storage.objects.createSelectedReadScope(params)
        return Object.create(selected, {
          queryObjects: {
            value: (input: QueryObjectsInput) => {
              providerQueries.push(input.query)
              return selected.queryObjects?.(input)
            },
          },
        })
      },
    },
  })
  const reader = createAuthorizedObjectReader({
    scope: createDelegatedRequestScope({
      projectId,
      requestId: "request-text",
      correlationId: "correlation-text",
      objectRead: {
        selection: {
          kind: "selected",
          roots: [
            {
              anchor: { objectTypeId: Note.id, primaryId: "note-1" },
              node: {
                objects: [{ objectTypeId: Note.id, propertyIds: ["id", "title"] }],
                links: [],
              },
            },
          ],
        },
        limits: { maxTraversalFacts: 100, maxOutputJsonBytes: 100_000 },
      },
    }),
    ontology,
    objectStorage,
  })

  const result = await reader.executeQuery({
    query: {
      kind: "text",
      input: { kind: "refs", refs: [{ objectTypeId: Note.id, primaryId: "note-1" }] },
      query: "Visible",
    },
  })
  expect(result.objects.map((row) => row.primaryId)).toEqual(["note-1"])
  expect(providerQueries).toEqual([
    expect.objectContaining({ fieldsByObjectType: { [Note.id]: ["title"] } }),
  ])
})
