import { describe, expect, test } from "bun:test"
import { emptyGrantIndex } from "../src/authorization"
import { AuthorizationError } from "../src/authorization/errors"
import {
  type AuthorizedObjectReader,
  assertAuthorizedObjectReaderBinding,
  createAuthorizedObjectReader,
} from "../src/execution/authorized-object-reader"
import { createDisabledRequestScope, createPrincipalRequestScope } from "../src/execution/scopes"
import type { ExecutionScope } from "../src/execution/types"
import type { ObjectQuery } from "../src/objects/query"
import { defineObjectType, link, OntologyRegistry, prop } from "../src/ontology"
import {
  linkBatchKey,
  type ObjectLinkRow,
  type ObjectQueryCapabilities,
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

type ReadCall = {
  readonly operation: string
  readonly input?: unknown
}

function createReadStorage(options?: {
  readonly ignoreEndpointTypeFilter?: boolean
  readonly queryLinksHasMore?: boolean
}): {
  readonly storage: ObjectStorage
  readonly calls: ReadCall[]
  readonly selectedScopeCalls: number
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
    createSelectedReadScope() {
      selectedScopeCalls += 1
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
    rows,
    links,
  }
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
