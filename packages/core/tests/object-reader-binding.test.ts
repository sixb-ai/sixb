import { describe, expect, test } from "bun:test"
import { emptyGrantIndex } from "../src/authorization"
import { AuthorizationError } from "../src/authorization/errors"
import { resolveRuntimeAuthorization } from "../src/execution/authorization"
import {
  type AuthorizedObjectReader,
  assertAuthorizedObjectReaderBinding,
  createAuthorizedObjectReader,
} from "../src/execution/authorized-object-reader"
import {
  createDelegatedRequestScope,
  createDisabledRequestScope,
  createPrincipalRequestScope,
} from "../src/execution/scopes"
import type { ExecutionScope } from "../src/execution/types"
import {
  countObjects,
  executeObjectQuery,
  executeObjectQueryLinks,
  existsObjects,
  facetObjects,
  type ObjectQuery,
  ObjectQueryExecutionError,
  ObjectQueryValidationError,
} from "../src/objects/query"
import { defineObjectType, link, OntologyRegistry, prop } from "../src/ontology"
import {
  linkBatchKey,
  MAX_OBJECT_READ_FACETS,
  type ObjectLinkRow,
  type ObjectQueryCapabilities,
  type ObjectReadExecutionLimits,
  type ObjectReadStorage,
  type ObjectRow,
  type ObjectStorage,
  objectBatchKey,
} from "../src/storage"

const projectId = "authorized-object-reader"
const at = new Date("2026-01-01T00:00:00.000Z")

const LineItem = defineObjectType({
  id: "LineItem",
  name: "Line item",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

const Secret = defineObjectType({
  id: "Secret",
  name: "Secret",
  properties: [prop("id", "string", { required: true, primary: true }), prop("value", "string")],
})

const Proposal = defineObjectType({
  id: "Proposal",
  name: "Proposal",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { query: { searchable: true, facet: true } }),
    prop("internal", "string", {
      query: { searchable: true, filterable: true, facet: true },
    }),
  ],
  links: [link("items", LineItem), link("secret", Secret)],
})

const ontology = new OntologyRegistry({ sources: [Proposal, LineItem, Secret] })

type PublicReaderMethod =
  | "getByPrimaryId"
  | "getByPrimaryIdBatch"
  | "canReadObjectProperty"
  | "canReadObjectPropertiesBatch"
  | "list"
  | "listLinks"
  | "listLinksBatch"
  | "executeQuery"
  | "queryLinks"
  | "count"
  | "exists"
  | "facet"

type InputsWithoutProjectId = {
  [Method in PublicReaderMethod]: "projectId" extends keyof Parameters<
    AuthorizedObjectReader[Method]
  >[0]
    ? never
    : true
}

const inputsWithoutProjectId: InputsWithoutProjectId = {
  getByPrimaryId: true,
  getByPrimaryIdBatch: true,
  canReadObjectProperty: true,
  canReadObjectPropertiesBatch: true,
  list: true,
  listLinks: true,
  listLinksBatch: true,
  executeQuery: true,
  queryLinks: true,
  count: true,
  exists: true,
  facet: true,
}

type FacadeIsNominal =
  Pick<AuthorizedObjectReader, keyof AuthorizedObjectReader> extends AuthorizedObjectReader
    ? never
    : true

const facadeIsNominal: FacadeIsNominal = true

describe("AuthorizedObjectReader", () => {
  test("is a frozen nominal facade that injects project identity", () => {
    const backend = createReadStorage()
    const reader = createAuthorizedObjectReader({
      scope: principalScope("shape", [Proposal.id]),
      ontology,
      objectStorage: backend.storage,
    })

    expect(facadeIsNominal).toBe(true)
    expect(Object.values(inputsWithoutProjectId).every(Boolean)).toBe(true)
    expect(reader.projectId).toBe(projectId)
    expect(Object.isFrozen(reader)).toBe(true)
    expect(Object.isFrozen(Object.getPrototypeOf(reader))).toBe(true)
    expect(backend.selectedScopeCalls).toBe(0)

    const ReaderConstructor = Object.getPrototypeOf(reader).constructor as new (
      ...args: unknown[]
    ) => unknown
    expect(() => Reflect.construct(ReaderConstructor, [])).toThrow(
      "AuthorizedObjectReader can only be created by Core"
    )
  })

  test("is bound to one exact registered execution authority", () => {
    const backend = createReadStorage()
    const first = principalScope("first", [Proposal.id])
    const second = principalScope("second", [Proposal.id])
    const reader = createAuthorizedObjectReader({
      scope: first,
      ontology,
      objectStorage: backend.storage,
    })

    expect(() => assertAuthorizedObjectReaderBinding({ reader, scope: first })).not.toThrow()
    expect(() => assertAuthorizedObjectReaderBinding({ reader, scope: second })).toThrow(
      "AuthorizedObjectReader is not bound to this exact execution authority"
    )

    const mismatchedExecution: ExecutionScope = {
      execution: second.execution,
      authorization: first.authorization,
    }
    expect(() =>
      assertAuthorizedObjectReaderBinding({ reader, scope: mismatchedExecution })
    ).toThrow("authority is bound to different execution provenance")
  })

  test("captures authority instead of retaining a mutable scope wrapper", () => {
    const backend = createReadStorage()
    const first = principalScope("captured", [Proposal.id])
    const second = principalScope("replacement", [Proposal.id])
    const mutableScope = {
      execution: first.execution,
      authorization: first.authorization,
    }
    const reader = createAuthorizedObjectReader({
      scope: mutableScope,
      ontology,
      objectStorage: backend.storage,
    })

    mutableScope.authorization = second.authorization

    expect(() => assertAuthorizedObjectReaderBinding({ reader, scope: first })).not.toThrow()
    expect(() => assertAuthorizedObjectReaderBinding({ reader, scope: second })).toThrow(
      "AuthorizedObjectReader is not bound to this exact execution authority"
    )
  })

  test("captures an accessor-backed scope atomically", () => {
    const backend = createReadStorage()
    const source = principalScope("accessor", [Proposal.id])
    let executionReads = 0
    let authorizationReads = 0
    const accessorScope = Object.defineProperties(
      {},
      {
        execution: {
          enumerable: true,
          get: () => {
            executionReads += 1
            return source.execution
          },
        },
        authorization: {
          enumerable: true,
          get: () => {
            authorizationReads += 1
            return source.authorization
          },
        },
      }
    ) as ExecutionScope

    const reader = createAuthorizedObjectReader({
      scope: accessorScope,
      ontology,
      objectStorage: backend.storage,
    })

    expect(reader.projectId).toBe(projectId)
    expect(executionReads).toBe(1)
    expect(authorizationReads).toBe(1)
  })

  test("denies principal reads before storage and bounds an unfiltered empty listing", async () => {
    const backend = createReadStorage()
    const reader = createAuthorizedObjectReader({
      scope: principalScope("denied"),
      ontology,
      objectStorage: backend.storage,
    })
    const query = { kind: "start" as const, objectTypeId: Proposal.id }

    for (const operation of [
      () => reader.getByPrimaryId({ objectTypeId: Proposal.id, primaryId: "proposal-1" }),
      () =>
        reader.getByPrimaryIdBatch({
          items: [{ objectTypeId: Proposal.id, primaryId: "proposal-1" }],
        }),
      () =>
        reader.canReadObjectProperty({
          objectTypeId: Proposal.id,
          primaryId: "proposal-1",
          propertyId: "title",
        }),
      () =>
        reader.canReadObjectPropertiesBatch({
          items: [{ objectTypeId: Proposal.id, primaryId: "proposal-1", propertyId: "title" }],
        }),
      () => reader.list({ objectTypeId: Proposal.id }),
      () => reader.listLinks({ objectTypeId: Proposal.id, objectId: "proposal-1" }),
      () =>
        reader.listLinksBatch({
          items: [{ objectTypeId: Proposal.id, objectId: "proposal-1", linkId: "items" }],
        }),
      () => reader.executeQuery({ query }),
      () => reader.queryLinks({ query }),
      () => reader.count({ query }),
      () => reader.exists({ query }),
      () => reader.facet({ query, facets: [{ propertyId: "title", limit: 10 }] }),
    ]) {
      await expect(operation()).rejects.toBeInstanceOf(AuthorizationError)
    }

    expect(await reader.list({})).toEqual({ objects: [], hasMore: false, total: 0 })
    expect(backend.calls).toEqual([])
  })

  test("covers every read terminal, scopes principal lists, and filters hidden link endpoints", async () => {
    const backend = createReadStorage()
    const reader = createAuthorizedObjectReader({
      scope: principalScope("allowed", [Proposal.id, LineItem.id]),
      ontology,
      objectStorage: backend.storage,
    })
    const query = { kind: "start" as const, objectTypeId: Proposal.id }

    expect(
      await reader.getByPrimaryId({ objectTypeId: Proposal.id, primaryId: "proposal-1" })
    ).toMatchObject({ objectTypeId: Proposal.id, primaryId: "proposal-1" })
    expect(
      await reader.getByPrimaryIdBatch({
        items: [
          { objectTypeId: Proposal.id, primaryId: "proposal-1" },
          { objectTypeId: LineItem.id, primaryId: "line-1" },
        ],
      })
    ).toHaveLength(2)
    expect(
      await reader.canReadObjectPropertiesBatch({
        items: [{ objectTypeId: Proposal.id, primaryId: "proposal-1", propertyId: "title" }],
      })
    ).toEqual([true])
    expect(
      await reader.canReadObjectProperty({
        objectTypeId: Proposal.id,
        primaryId: "proposal-1",
        propertyId: "title",
      })
    ).toBe(true)

    const listed = await reader.list({})
    expect(listed.objects.map((row) => row.objectTypeId)).toEqual([Proposal.id, LineItem.id])
    expect(backend.calls.find((call) => call.operation === "list")?.input).toMatchObject({
      projectId,
      objectTypeId: [Proposal.id, LineItem.id],
    })

    const links = await reader.listLinks({
      objectTypeId: Proposal.id,
      objectId: "proposal-1",
    })
    expect(links.map((row) => row.targetTypeId)).toEqual([LineItem.id])

    const linkPages = await reader.listLinksBatch({
      items: [{ objectTypeId: Proposal.id, objectId: "proposal-1", linkId: "items" }],
    })
    expect(
      linkPages
        .get(linkBatchKey(Proposal.id, "proposal-1", "items"))
        ?.map((row) => row.targetTypeId)
    ).toEqual([LineItem.id])

    expect((await reader.executeQuery({ query, includeTotal: true })).objects).toHaveLength(1)
    expect((await reader.count({ query })).count).toBe(1)
    expect((await reader.exists({ query })).exists).toBe(true)
    expect(
      (await reader.facet({ query, facets: [{ propertyId: "title", limit: 10 }] })).facets
    ).toEqual([{ propertyId: "title", buckets: [{ value: "Proposal", count: 1 }] }])

    const queriedLinks = await reader.queryLinks({ query, includeObjects: true })
    expect(queriedLinks.links.map((row) => row.targetTypeId)).toEqual([LineItem.id])
    expect(queriedLinks.objects.map((row) => row.objectTypeId)).toEqual([Proposal.id, LineItem.id])
    expect(backend.calls.find((call) => call.operation === "queryLinks")?.input).toMatchObject({
      projectId,
      endpointObjectTypeIds: [Proposal.id, LineItem.id],
    })

    expect(backend.selectedScopeCalls).toBe(0)
    expect(backend.calls.filter((call) => call.operation === "selectsObjectProperties")).toEqual([])
    for (const call of backend.calls) {
      if (call.operation === "queryCapabilities") continue
      expect(call.input).toMatchObject({ projectId })
    }
  })

  test("preserves unrestricted broad reads", async () => {
    const backend = createReadStorage()
    const reader = createAuthorizedObjectReader({
      scope: createDisabledRequestScope({
        projectId,
        requestId: "request-unrestricted",
        correlationId: "correlation-unrestricted",
      }),
      ontology,
      objectStorage: backend.storage,
    })

    const listed = await reader.list({})
    expect(listed.objects.map((row) => row.objectTypeId)).toEqual([
      Proposal.id,
      LineItem.id,
      Secret.id,
    ])
    expect(backend.calls.find((call) => call.operation === "list")?.input).toEqual({
      objectTypeId: undefined,
      primaryIdPrefix: undefined,
      primaryIdSuffix: undefined,
      updatedAfter: undefined,
      updatedBefore: undefined,
      createdAfter: undefined,
      createdBefore: undefined,
      limit: undefined,
      offset: undefined,
      orderBy: undefined,
      order: undefined,
      projectId,
    })

    const links = await reader.listLinks({
      objectTypeId: Proposal.id,
      objectId: "proposal-1",
    })
    expect(links.map((row) => row.targetTypeId)).toEqual([LineItem.id, Secret.id])
  })

  test("binds every delegated read terminal to one selected provider reader", async () => {
    const selectedCalls: ReadCall[] = []
    const selectedRows = [
      row(Proposal.id, "proposal-1", { id: "proposal-1", title: "Proposal" }),
      row(LineItem.id, "line-1", { id: "line-1", name: "Line" }),
    ]
    const selectedLinks = [
      objectLink("items", LineItem.id, "line-1", { position: 1 }),
      objectLink("unselected", LineItem.id, "line-1"),
    ]
    const backend = createReadStorage({
      selectedReader: createSelectedReader(selectedRows, selectedLinks, selectedCalls),
    })
    const scope = delegatedScope("terminals")
    const reader = createAuthorizedObjectReader({
      scope,
      ontology,
      objectStorage: backend.storage,
    })

    expect(backend.selectedScopeCalls).toBe(1)
    expect(backend.selectedScopeInputs).toHaveLength(1)
    expect(backend.selectedScopeInputs[0]).toMatchObject({
      projectId,
      limits: { maxTraversalFacts: 100, maxOutputJsonBytes: 4_096 },
    })
    const resolved = resolveRuntimeAuthorization(scope.authorization)
    expect(resolved.type).toBe("delegated")
    if (resolved.type !== "delegated") throw new Error("expected delegated authorization")
    expect(backend.selectedScopeInputs[0]?.scope).toBe(resolved.objectRead.scope)
    expect(backend.selectedScopeInputs[0]?.limits).toBe(resolved.objectRead.limits)

    await expect(
      reader.getByPrimaryId({ objectTypeId: Proposal.id, primaryId: "proposal-1" })
    ).resolves.toMatchObject({ primaryId: "proposal-1" })
    await expect(
      reader.getByPrimaryId({ objectTypeId: Proposal.id, primaryId: "proposal-2" })
    ).resolves.toBeNull()
    const batch = await reader.getByPrimaryIdBatch({
      items: [
        { objectTypeId: Proposal.id, primaryId: "proposal-1" },
        { objectTypeId: Proposal.id, primaryId: "proposal-2" },
      ],
    })
    expect(batch.size).toBe(1)
    await expect(
      reader.canReadObjectProperty({
        objectTypeId: Proposal.id,
        primaryId: "proposal-1",
        propertyId: "title",
      })
    ).resolves.toBe(true)
    await expect(
      reader.canReadObjectPropertiesBatch({
        items: [
          {
            objectTypeId: Proposal.id,
            primaryId: "proposal-1",
            propertyId: "title",
          },
          {
            objectTypeId: Proposal.id,
            primaryId: "proposal-1",
            propertyId: "secret",
          },
        ],
      })
    ).resolves.toEqual([true, false])
    await expect(reader.list({})).resolves.toMatchObject({ total: 2 })
    await expect(
      reader.listLinks({ objectTypeId: Proposal.id, objectId: "proposal-1" })
    ).resolves.toHaveLength(1)
    const linkBatch = await reader.listLinksBatch({
      items: [{ objectTypeId: Proposal.id, objectId: "proposal-1", linkId: "items" }],
    })
    expect(linkBatch.size).toBe(1)
    expect(linkBatch.get(linkBatchKey(Proposal.id, "proposal-1", "items"))).toHaveLength(1)
    await expect(
      reader.getByPrimaryId({ objectTypeId: Secret.id, primaryId: "secret-1" })
    ).rejects.toThrow("does not select object type 'Secret'")

    expect(selectedCalls.map((call) => call.operation)).toEqual([
      "getByPrimaryId",
      "getByPrimaryId",
      "getByPrimaryIdBatch",
      "selectsObjectProperties",
      "selectsObjectProperties",
      "list",
      "listLinks",
      "listLinksBatch",
    ])

    selectedCalls.length = 0
    const query = { kind: "start" as const, objectTypeId: Proposal.id }
    expect(await reader.executeQuery({ query, includeTotal: true })).toMatchObject({
      objects: [{ objectTypeId: Proposal.id, primaryId: "proposal-1" }],
      hasMore: false,
      total: 1,
    })
    expect(await reader.count({ query })).toMatchObject({ count: 1 })
    expect(await reader.exists({ query })).toMatchObject({ exists: true })
    expect(
      await reader.facet({ query, facets: [{ propertyId: "title", limit: 10 }] })
    ).toMatchObject({
      facets: [{ propertyId: "title", buckets: [{ value: "Proposal", count: 1 }] }],
    })
    expect(
      await reader.queryLinks({
        query,
        direction: "outgoing",
        linkId: "items",
        includeObjects: true,
      })
    ).toMatchObject({
      links: [{ linkId: "items", targetId: "line-1" }],
      objects: [
        { objectTypeId: Proposal.id, primaryId: "proposal-1" },
        { objectTypeId: LineItem.id, primaryId: "line-1" },
      ],
      hasMore: false,
    })

    const guessedSibling = await reader.executeQuery({
      query: {
        kind: "refs",
        refs: [{ objectTypeId: Proposal.id, primaryId: "proposal-2" }],
      },
    })
    expect(guessedSibling.objects).toEqual([])
    expect(selectedCalls.map((call) => call.operation)).toContain("queryObjects")
    expect(selectedCalls.map((call) => call.operation)).toContain("countObjects")
    expect(selectedCalls.map((call) => call.operation)).toContain("existsObjects")
    expect(selectedCalls.map((call) => call.operation)).toContain("facetObjects")
    expect(selectedCalls.map((call) => call.operation)).toContain("queryLinks")
    expect(backend.selectedScopeCalls).toBe(1)
    expect(backend.calls).toEqual([])

    selectedCalls.length = 0
    const deniedOperations = [
      () =>
        reader.executeQuery({
          query: {
            kind: "filter" as const,
            input: query,
            predicate: { op: "eq" as const, propertyId: "internal", value: "hidden" },
          },
        }),
      () =>
        reader.count({
          query: {
            kind: "traverse" as const,
            input: query,
            linkId: "secret",
            direction: "outgoing" as const,
          },
        }),
      () =>
        reader.exists({
          query: {
            kind: "refs" as const,
            refs: [{ objectTypeId: Secret.id, primaryId: "secret-1" }],
          },
        }),
      () => reader.facet({ query, facets: [{ propertyId: "internal", limit: 10 }] }),
      () => reader.queryLinks({ query, direction: "outgoing", linkId: "secret" }),
    ]
    for (const operation of deniedOperations) {
      await expect(operation()).rejects.toBeInstanceOf(AuthorizationError)
      expect(selectedCalls).toEqual([])
    }
  })

  test("validates delegated terminal parameters before terminal-specific admission", async () => {
    const selectedCalls: ReadCall[] = []
    const backend = createReadStorage({
      selectedReader: createSelectedReader(
        [row(Proposal.id, "proposal-1", { id: "proposal-1", title: "Proposal" })],
        [objectLink("items", LineItem.id, "line-1")],
        selectedCalls
      ),
    })
    const reader = createAuthorizedObjectReader({
      scope: delegatedScope("validation-order"),
      ontology,
      objectStorage: backend.storage,
    })
    const query = { kind: "start" as const, objectTypeId: Proposal.id }

    const invalidLinks = reader.queryLinks({
      query,
      direction: "sideways",
      linkId: "secret",
    } as unknown as Parameters<AuthorizedObjectReader["queryLinks"]>[0])
    await expect(invalidLinks).rejects.toMatchObject({
      code: "invalid_link_direction",
      path: "$.direction",
    })
    await expect(invalidLinks).rejects.toBeInstanceOf(ObjectQueryExecutionError)

    const invalidFacets = reader.facet({
      query,
      facets: [{ propertyId: "internal", limit: 0 }],
    })
    await expect(invalidFacets).rejects.toBeInstanceOf(ObjectQueryValidationError)
    await expect(invalidFacets).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: "invalid_facet_limit" })]),
    })

    let oversizedFacetReads = 0
    const oversizedFacets = Array.from({ length: MAX_OBJECT_READ_FACETS + 1 }, () => ({
      propertyId: "internal",
      limit: 1,
    }))
    Object.defineProperty(oversizedFacets, 0, {
      get: () => {
        oversizedFacetReads += 1
        throw new Error("oversized facet must not be read")
      },
    })
    await expect(reader.facet({ query, facets: oversizedFacets })).rejects.toBeInstanceOf(
      ObjectQueryValidationError
    )
    expect(oversizedFacetReads).toBe(0)

    expect(selectedCalls).toEqual([])
    expect(backend.calls).toEqual([])
  })

  test("keeps delegated runtime authorization unusable at low-level query executors", async () => {
    const backend = createReadStorage()
    const scope = delegatedScope("low-level")
    const query = { kind: "start" as const, objectTypeId: Proposal.id }
    const options = {
      ontology,
      storage: backend.storage,
      runtimeAuthorization: scope.authorization,
    }

    for (const operation of [
      () => executeObjectQuery({ projectId, query }, options),
      () => countObjects({ projectId, query }, options),
      () => existsObjects({ projectId, query }, options),
      () =>
        facetObjects({ projectId, query, facets: [{ propertyId: "title", limit: 10 }] }, options),
      () => executeObjectQueryLinks({ projectId, query }, options),
    ]) {
      await expect(operation()).rejects.toBeInstanceOf(AuthorizationError)
    }

    expect(backend.calls).toEqual([])
    expect(backend.selectedScopeCalls).toBe(0)
  })

  test("executes the exact delegated query snapshot it admits", async () => {
    let objectTypeReads = 0
    const authoredQuery = Object.defineProperties(
      {},
      {
        kind: { enumerable: true, value: "start" },
        objectTypeId: {
          enumerable: true,
          get: () => (objectTypeReads++ === 0 ? Proposal.id : Secret.id),
        },
      }
    ) as ObjectQuery
    const selectedCalls: ReadCall[] = []
    const backend = createReadStorage({
      selectedReader: createSelectedReader(
        [row(Proposal.id, "proposal-1", { id: "proposal-1", title: "Proposal" })],
        [],
        selectedCalls
      ),
    })
    const reader = createAuthorizedObjectReader({
      scope: delegatedScope("snapshot"),
      ontology,
      objectStorage: backend.storage,
    })

    await expect(reader.executeQuery({ query: authoredQuery })).resolves.toMatchObject({
      objects: [{ objectTypeId: Proposal.id, primaryId: "proposal-1" }],
    })

    expect(objectTypeReads).toBe(1)
    expect(selectedCalls.find((call) => call.operation === "queryObjects")?.input).toMatchObject({
      projectId,
      query: { kind: "start", objectTypeId: Proposal.id },
    })

    let queryReads = 0
    let linkIdReads = 0
    const linkRequest = Object.defineProperties(
      {},
      {
        query: {
          enumerable: true,
          get: () => {
            queryReads += 1
            return {
              kind: "start",
              objectTypeId: queryReads === 1 ? Proposal.id : Secret.id,
            }
          },
        },
        linkId: {
          enumerable: true,
          get: () => (linkIdReads++ === 0 ? "items" : "secret"),
        },
      }
    ) as Parameters<AuthorizedObjectReader["queryLinks"]>[0]
    await expect(reader.queryLinks(linkRequest)).resolves.toMatchObject({ links: [] })

    expect(queryReads).toBe(1)
    expect(linkIdReads).toBe(1)
    expect(
      [...selectedCalls].reverse().find((call) => call.operation === "queryLinks")?.input
    ).toMatchObject({ projectId, linkId: "items" })
    expect(backend.calls).toEqual([])
  })

  test("ignores caller project extras and executes the exact query snapshot it authorized", async () => {
    let objectTypeReads = 0
    const authoredQuery = Object.defineProperties(
      {},
      {
        kind: { enumerable: true, value: "start" },
        objectTypeId: {
          enumerable: true,
          get: () => (objectTypeReads++ === 0 ? Proposal.id : Secret.id),
        },
      }
    ) as ObjectQuery
    const backend = createReadStorage()
    const reader = createAuthorizedObjectReader({
      scope: principalScope("snapshot", [Proposal.id]),
      ontology,
      objectStorage: backend.storage,
    })

    await reader.getByPrimaryId({
      objectTypeId: Proposal.id,
      primaryId: "proposal-1",
      projectId: "other-project",
    } as Parameters<AuthorizedObjectReader["getByPrimaryId"]>[0])
    await reader.executeQuery({
      query: authoredQuery,
      projectId: "other-project",
    } as Parameters<AuthorizedObjectReader["executeQuery"]>[0])

    expect(objectTypeReads).toBe(1)
    expect(backend.calls.find((call) => call.operation === "getByPrimaryId")?.input).toEqual({
      objectTypeId: Proposal.id,
      primaryId: "proposal-1",
      projectId,
    })
    expect(backend.calls.find((call) => call.operation === "queryObjects")?.input).toMatchObject({
      projectId,
      query: { kind: "start", objectTypeId: Proposal.id },
    })
  })

  test("detaches provider-owned rows, maps, and links", async () => {
    const backend = createReadStorage()
    const reader = createAuthorizedObjectReader({
      scope: principalScope("detach", [Proposal.id, LineItem.id]),
      ontology,
      objectStorage: backend.storage,
    })

    const object = await reader.getByPrimaryId({
      objectTypeId: Proposal.id,
      primaryId: "proposal-1",
    })
    object!.properties.title = "mutated"
    expect(backend.rows.proposal.properties.title).toBe("Proposal")

    const batch = await reader.getByPrimaryIdBatch({
      items: [{ objectTypeId: LineItem.id, primaryId: "line-1" }],
    })
    batch.get(objectBatchKey(LineItem.id, "line-1"))!.properties.name = "mutated"
    expect(backend.rows.line.properties.name).toBe("Line")

    const links = await reader.listLinks({
      objectTypeId: Proposal.id,
      objectId: "proposal-1",
    })
    links[0].properties!.position = 99
    expect(backend.links[0].properties?.position).toBe(1)
  })

  test("fails closed when a provider returns a hidden endpoint in a paginated link page", async () => {
    const backend = createReadStorage({ ignoreEndpointTypeFilter: true, queryLinksHasMore: true })
    const reader = createAuthorizedObjectReader({
      scope: principalScope("invalid-link-page", [Proposal.id, LineItem.id]),
      ontology,
      objectStorage: backend.storage,
    })

    await expect(
      reader.queryLinks({
        query: { kind: "start", objectTypeId: Proposal.id },
        includeObjects: true,
      })
    ).rejects.toThrow("Object storage returned a link page outside its authorized scope")
  })
})

function principalScope(id: string, view: readonly string[] = []): ExecutionScope {
  return createPrincipalRequestScope({
    projectId,
    requestId: `request-${id}`,
    correlationId: `correlation-${id}`,
    context: {
      principal: { type: "user", id: `user-${id}` },
      groupIds: [],
      roleIds: [],
      grants: { ...emptyGrantIndex(), "view:object": new Set(view) },
    },
  })
}

function delegatedScope(id: string): ExecutionScope {
  return createDelegatedRequestScope({
    projectId,
    requestId: `request-${id}`,
    correlationId: `correlation-${id}`,
    objectRead: {
      selection: {
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
                    objects: [{ objectTypeId: LineItem.id, propertyIds: ["id", "name"] }],
                    links: [],
                  },
                },
              ],
            },
          },
        ],
      },
      limits: { maxTraversalFacts: 100, maxOutputJsonBytes: 4_096 },
    },
  })
}

type ReadCall = {
  readonly operation: string
  readonly input?: unknown
}

function createReadStorage(options?: {
  readonly ignoreEndpointTypeFilter?: boolean
  readonly queryLinksHasMore?: boolean
  readonly selectedReader?: ObjectReadStorage
}): {
  readonly storage: ObjectStorage
  readonly calls: ReadCall[]
  readonly selectedScopeCalls: number
  readonly selectedScopeInputs: readonly {
    readonly projectId: string
    readonly scope: Parameters<ObjectStorage["createSelectedReadScope"]>[0]["scope"]
    readonly limits: ObjectReadExecutionLimits
  }[]
  readonly rows: {
    readonly proposal: ObjectRow
    readonly line: ObjectRow
    readonly secret: ObjectRow
  }
  readonly links: readonly ObjectLinkRow[]
} {
  const calls: ReadCall[] = []
  const rows = {
    proposal: row(Proposal.id, "proposal-1", { id: "proposal-1", title: "Proposal" }),
    line: row(LineItem.id, "line-1", { id: "line-1", name: "Line" }),
    secret: row(Secret.id, "secret-1", { id: "secret-1", value: "hidden" }),
  }
  const allRows = [rows.proposal, rows.line, rows.secret]
  const links: ObjectLinkRow[] = [
    objectLink("items", LineItem.id, "line-1", { position: 1 }),
    objectLink("secret", Secret.id, "secret-1"),
  ]
  let selectedScopeCalls = 0
  const selectedScopeInputs: {
    projectId: string
    scope: Parameters<ObjectStorage["createSelectedReadScope"]>[0]["scope"]
    limits: ObjectReadExecutionLimits
  }[] = []
  const record = (operation: string, input?: unknown): void => {
    calls.push({ operation, ...(input === undefined ? {} : { input }) })
  }
  const capabilities: ObjectQueryCapabilities = {
    queryObjects: true,
    countObjects: true,
    existsObjects: true,
    facetObjects: true,
    nodes: { start: true, limit: true },
  }

  const storage: ObjectStorage = {
    queryCapabilities() {
      record("queryCapabilities")
      return capabilities
    },
    async queryObjects(input) {
      record("queryObjects", input)
      return { objects: [rows.proposal], hasMore: false, total: 1 }
    },
    async countObjects(input) {
      record("countObjects", input)
      return { count: 1 }
    },
    async existsObjects(input) {
      record("existsObjects", input)
      return { exists: true }
    },
    async facetObjects(input) {
      record("facetObjects", input)
      return {
        facets: input.facets.map((facet) => ({
          propertyId: facet.propertyId,
          buckets: [{ value: "Proposal", count: 1 }],
        })),
      }
    },
    async getByPrimaryId(input) {
      record("getByPrimaryId", input)
      return findRow(allRows, input.objectTypeId, input.primaryId)
    },
    async getByPrimaryIdBatch(input) {
      record("getByPrimaryIdBatch", input)
      const result = new Map()
      for (const item of input.items) {
        const found = findRow(allRows, item.objectTypeId, item.primaryId)
        if (found) result.set(objectBatchKey(item.objectTypeId, item.primaryId), found)
      }
      return result
    },
    async selectsObjectProperties(input) {
      record("selectsObjectProperties", input)
      return input.items.map((item) => Boolean(findRow(allRows, item.objectTypeId, item.primaryId)))
    },
    async listLinks(input) {
      record("listLinks", input)
      return links
    },
    async listLinksBatch(input) {
      record("listLinksBatch", input)
      return new Map(
        input.items.map((item) => [
          linkBatchKey(item.objectTypeId, item.objectId, item.linkId),
          links,
        ])
      )
    },
    async queryLinks(input) {
      record("queryLinks", input)
      const endpointObjectTypeIds =
        options?.ignoreEndpointTypeFilter || input.endpointObjectTypeIds === undefined
          ? undefined
          : new Set(input.endpointObjectTypeIds)
      const visibleLinks = endpointObjectTypeIds
        ? links.filter(
            (link) =>
              endpointObjectTypeIds.has(link.sourceTypeId) &&
              endpointObjectTypeIds.has(link.targetTypeId)
          )
        : links
      return { links: visibleLinks, hasMore: options?.queryLinksHasMore ?? false }
    },
    async list(input) {
      record("list", input)
      const requested =
        input.objectTypeId === undefined
          ? undefined
          : new Set(
              typeof input.objectTypeId === "string" ? [input.objectTypeId] : input.objectTypeId
            )
      const objects = requested
        ? allRows.filter((candidate) => requested.has(candidate.objectTypeId))
        : allRows
      return { objects, hasMore: false, total: objects.length }
    },
    createSelectedReadScope(input) {
      selectedScopeCalls += 1
      selectedScopeInputs.push(input)
      if (options?.selectedReader) return options.selectedReader
      throw new Error("createSelectedReadScope must not be called for existing authorities")
    },
    async listIncidentLinksBatch() {
      return []
    },
    async listByPrimaryIdPage() {
      return { objects: [] }
    },
  }

  return {
    storage,
    calls,
    get selectedScopeCalls() {
      return selectedScopeCalls
    },
    selectedScopeInputs,
    rows,
    links,
  }
}

function createSelectedReader(
  rows: readonly ObjectRow[],
  links: readonly ObjectLinkRow[],
  calls: ReadCall[]
): ObjectReadStorage {
  const record = (operation: string, input?: unknown): void => {
    calls.push({ operation, ...(input === undefined ? {} : { input }) })
  }
  return {
    queryCapabilities() {
      record("queryCapabilities")
      return {
        queryObjects: true,
        countObjects: true,
        existsObjects: true,
        facetObjects: true,
        nodes: { start: true, refs: true, limit: true },
      }
    },
    async queryObjects(input) {
      record("queryObjects", input)
      const objects = selectedQueryRows(rows, input.query)
      return {
        objects,
        hasMore: false,
        ...(input.includeTotal ? { total: objects.length } : {}),
      }
    },
    async countObjects(input) {
      record("countObjects", input)
      return { count: selectedQueryRows(rows, input.query).length }
    },
    async existsObjects(input) {
      record("existsObjects", input)
      return { exists: selectedQueryRows(rows, input.query).length > 0 }
    },
    async facetObjects(input) {
      record("facetObjects", input)
      const objects = selectedQueryRows(rows, input.query)
      return {
        facets: input.facets.map((facet) => ({
          propertyId: facet.propertyId,
          buckets: facetBuckets(objects, facet.propertyId, facet.limit),
        })),
      }
    },
    async getByPrimaryId(input) {
      record("getByPrimaryId", input)
      return findRow(rows, input.objectTypeId, input.primaryId)
    },
    async getByPrimaryIdBatch(input) {
      record("getByPrimaryIdBatch", input)
      const result = new Map()
      for (const item of input.items) {
        const found = findRow(rows, item.objectTypeId, item.primaryId)
        if (found) result.set(objectBatchKey(item.objectTypeId, item.primaryId), found)
      }
      return result
    },
    async selectsObjectProperties(input) {
      record("selectsObjectProperties", input)
      return input.items.map(
        (item) =>
          item.objectTypeId === Proposal.id &&
          item.primaryId === "proposal-1" &&
          item.propertyId === "title"
      )
    },
    async listLinks(input) {
      record("listLinks", input)
      return links
    },
    async listLinksBatch(input) {
      record("listLinksBatch", input)
      return new Map(
        input.items.map((item) => [
          linkBatchKey(item.objectTypeId, item.objectId, item.linkId),
          [...links],
        ])
      )
    },
    async queryLinks(input) {
      record("queryLinks", input)
      const selectedRefs = new Set(
        input.objectRefs.map((ref) => objectBatchKey(ref.objectTypeId, ref.primaryId))
      )
      const visibleLinks = links
        .filter((link) => link.linkId === "items")
        .filter((link) => input.linkId === undefined || link.linkId === input.linkId)
        .filter((link) => {
          const sourceSelected = selectedRefs.has(objectBatchKey(link.sourceTypeId, link.sourceId))
          const targetSelected = selectedRefs.has(objectBatchKey(link.targetTypeId, link.targetId))
          if (input.direction === "outgoing") return sourceSelected
          if (input.direction === "incoming") return targetSelected
          return sourceSelected || targetSelected
        })
      return { links: visibleLinks.slice(0, input.limit), hasMore: false }
    },
    async list(input) {
      record("list", input)
      const requested =
        input.objectTypeId === undefined
          ? undefined
          : new Set(
              typeof input.objectTypeId === "string" ? [input.objectTypeId] : input.objectTypeId
            )
      const objects = requested ? rows.filter((row) => requested.has(row.objectTypeId)) : [...rows]
      return { objects, hasMore: false, total: objects.length }
    },
  }
}

function selectedQueryRows(rows: readonly ObjectRow[], query: ObjectQuery): ObjectRow[] {
  switch (query.kind) {
    case "start":
      return rows.filter((row) => row.objectTypeId === query.objectTypeId)
    case "refs": {
      const refs = new Set(query.refs.map((ref) => objectBatchKey(ref.objectTypeId, ref.primaryId)))
      return rows.filter((row) => refs.has(objectBatchKey(row.objectTypeId, row.primaryId)))
    }
    case "limit":
      return selectedQueryRows(rows, query.input).slice(0, query.limit)
    default:
      return []
  }
}

function facetBuckets(
  rows: readonly ObjectRow[],
  propertyId: string,
  limit: number
): readonly { value: unknown; count: number }[] {
  const counts = new Map<unknown, number>()
  for (const row of rows) {
    const value = row.properties[propertyId]
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts].slice(0, limit).map(([value, count]) => ({ value, count }))
}

function row(
  objectTypeId: string,
  primaryId: string,
  properties: Record<string, unknown>
): ObjectRow {
  return {
    projectId,
    objectTypeId,
    primaryId,
    properties,
    createdAt: at,
    updatedAt: at,
    version: 1,
    lastCommitId: `commit-${primaryId}`,
  }
}

function objectLink(
  linkId: string,
  targetTypeId: string,
  targetId: string,
  properties?: Record<string, unknown>
): ObjectLinkRow {
  return {
    projectId,
    sourceTypeId: Proposal.id,
    sourceId: "proposal-1",
    linkId,
    targetTypeId,
    targetId,
    ...(properties === undefined ? {} : { properties }),
    createdAt: at,
    updatedAt: at,
    lastCommitId: `commit-${linkId}`,
  }
}

function findRow(
  rows: readonly ObjectRow[],
  objectTypeId: string,
  primaryId: string
): ObjectRow | null {
  return (
    rows.find(
      (candidate) => candidate.objectTypeId === objectTypeId && candidate.primaryId === primaryId
    ) ?? null
  )
}
