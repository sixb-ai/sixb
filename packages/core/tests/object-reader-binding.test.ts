import { describe, expect, test } from "bun:test"
import { emptyGrantIndex } from "../src/authorization"
import type { RuntimeAccessPlan } from "../src/authorization/access-plan"
import { AuthorizationError } from "../src/authorization/errors"
import { createTrustedPrimitiveRuntimeAuthorization } from "../src/execution/authorization"
import {
  type AuthorizedObjectReader,
  assertAuthorizedObjectReaderBinding,
  createAuthorizedObjectReader,
} from "../src/execution/authorized-object-reader"
import { createDelegatedRequestScope, createPrincipalRequestScope } from "../src/execution/scopes"
import type { ExecutionContext, ExecutionScope, TrustedPrimitiveRef } from "../src/execution/types"
import type { ObjectQuery } from "../src/objects/query"
import { defineObjectType, link, OntologyRegistry, prop } from "../src/ontology"
import type {
  ObjectQueryCapabilities,
  ObjectReadScope,
  ObjectReadStorage,
  ObjectRow,
  ObjectStorage,
} from "../src/storage"

const projectId = "authorized-object-reader"

const LineItem = defineObjectType({
  id: "LineItem",
  name: "Line item",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

const Proposal = defineObjectType({
  id: "Proposal",
  name: "Proposal",
  properties: [prop("id", "string", { required: true, primary: true }), prop("title", "string")],
  links: [link("items", LineItem), link("reviewers", LineItem)],
})

const ontology = new OntologyRegistry({ sources: [Proposal, LineItem] })

const selection: ObjectReadScope = {
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
                propertyIds: [],
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
}

const access: RuntimeAccessPlan = {
  grants: [{ kind: "object.view", selection }],
}

type PublicReaderMethod =
  | "getByPrimaryId"
  | "list"
  | "listLinks"
  | "canReadObjectProperty"
  | "canReadObjectPropertiesMany"
  | "executeQuery"
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
  list: true,
  listLinks: true,
  canReadObjectProperty: true,
  canReadObjectPropertiesMany: true,
  executeQuery: true,
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
  test("keeps the Core facade nominal and injects project identity itself", () => {
    expect(facadeIsNominal).toBe(true)
    expect(inputsWithoutProjectId).toEqual({
      getByPrimaryId: true,
      list: true,
      listLinks: true,
      canReadObjectProperty: true,
      canReadObjectPropertiesMany: true,
      executeQuery: true,
      count: true,
      exists: true,
      facet: true,
    })
  })

  test("creates a facade for principal, delegated, and trusted scopes but scopes only delegated storage", () => {
    const backend = createReadStorage()
    const createReadScopeCalls: Parameters<ObjectStorage["createReadScope"]>[0][] = []
    const objectStorage = createObjectStorage(backend.storage, (input) => {
      createReadScopeCalls.push(input)
      return backend.storage
    })
    const principal = principalScope("principal", [Proposal.id])
    const delegated = delegatedScope("delegated")
    const trusted = trustedScope("trusted")

    const principalReader = createAuthorizedObjectReader({
      scope: principal,
      ontology,
      objectStorage,
    })
    const trustedReader = createAuthorizedObjectReader({ scope: trusted, ontology, objectStorage })

    expect(createReadScopeCalls).toHaveLength(0)

    const delegatedReader = createAuthorizedObjectReader({
      scope: delegated,
      ontology,
      objectStorage,
    })

    expect(createReadScopeCalls).toHaveLength(1)
    expect(createReadScopeCalls[0]).toMatchObject({ projectId, scope: selection })
    for (const [reader, scope] of [
      [principalReader, principal],
      [delegatedReader, delegated],
      [trustedReader, trusted],
    ] as const) {
      expect(() => assertAuthorizedObjectReaderBinding({ reader, scope })).not.toThrow()
    }
  })

  test("rejects recombining a facade with another execution or authority", () => {
    const backend = createReadStorage()
    const objectStorage = createObjectStorage(backend.storage, () => backend.storage)
    const first = principalScope("first", [Proposal.id])
    const second = principalScope("second", [Proposal.id])
    const reader = createAuthorizedObjectReader({ scope: first, ontology, objectStorage })

    expect(() => assertAuthorizedObjectReaderBinding({ reader, scope: first })).not.toThrow()
    expect(() => assertAuthorizedObjectReaderBinding({ reader, scope: second })).toThrow(
      "AuthorizedObjectReader is not bound to this exact execution authority"
    )

    const otherExecution: ExecutionScope = {
      execution: second.execution,
      authorization: first.authorization,
    }
    expect(() => assertAuthorizedObjectReaderBinding({ reader, scope: otherExecution })).toThrow(
      "authority is bound to different execution provenance"
    )

    const otherAuthority: ExecutionScope = {
      execution: first.execution,
      authorization: second.authorization,
    }
    expect(() => assertAuthorizedObjectReaderBinding({ reader, scope: otherAuthority })).toThrow(
      "authority is bound to different execution provenance"
    )
  })

  test("denies unauthorized principal gets and queries before touching storage", async () => {
    const backend = createReadStorage()
    const objectStorage = createObjectStorage(backend.storage, () => backend.storage)
    const reader = createAuthorizedObjectReader({
      scope: principalScope("unauthorized"),
      ontology,
      objectStorage,
    })

    await expect(
      reader.getByPrimaryId({ objectTypeId: Proposal.id, primaryId: "proposal-1" })
    ).rejects.toBeInstanceOf(AuthorizationError)
    expect(() =>
      reader.executeQuery({ query: { kind: "start", objectTypeId: Proposal.id } })
    ).toThrow(AuthorizationError)

    expect(backend.calls).toEqual([])
  })

  test("returns null for a delegated guessed sibling and rejects an unselected path before querying storage", async () => {
    const backend = createReadStorage({ getByPrimaryId: async () => null })
    const objectStorage = createObjectStorage(backend.storage, () => backend.storage)
    const reader = createAuthorizedObjectReader({
      scope: delegatedScope("narrow"),
      ontology,
      objectStorage,
    })

    expect(
      await reader.getByPrimaryId({ objectTypeId: Proposal.id, primaryId: "proposal-2" })
    ).toBeNull()
    expect(backend.calls).toEqual([
      {
        operation: "getByPrimaryId",
        input: { projectId, objectTypeId: Proposal.id, primaryId: "proposal-2" },
      },
    ])

    expect(() =>
      reader.executeQuery({
        query: {
          kind: "traverse",
          input: { kind: "start", objectTypeId: Proposal.id },
          linkId: "reviewers",
          direction: "outgoing",
        },
      })
    ).toThrow(AuthorizationError)
    expect(backend.calls).toHaveLength(1)
  })

  test("binds the Core facade even when a provider reuses one scoped backend", () => {
    const sharedBackend = createReadStorage()
    const createReadScopeCalls: Parameters<ObjectStorage["createReadScope"]>[0][] = []
    const objectStorage = createObjectStorage(sharedBackend.storage, (input) => {
      createReadScopeCalls.push(input)
      return sharedBackend.storage
    })
    const first = delegatedScope("shared-one")
    const second = delegatedScope("shared-two")

    const firstReader = createAuthorizedObjectReader({ scope: first, ontology, objectStorage })
    const secondReader = createAuthorizedObjectReader({ scope: second, ontology, objectStorage })

    expect(createReadScopeCalls).toHaveLength(2)
    expect(() =>
      assertAuthorizedObjectReaderBinding({ reader: firstReader, scope: first })
    ).not.toThrow()
    expect(() =>
      assertAuthorizedObjectReaderBinding({ reader: secondReader, scope: second })
    ).not.toThrow()
    expect(() =>
      assertAuthorizedObjectReaderBinding({ reader: firstReader, scope: second })
    ).toThrow("AuthorizedObjectReader is not bound to this exact execution authority")
    expect(() =>
      assertAuthorizedObjectReaderBinding({ reader: secondReader, scope: first })
    ).toThrow("AuthorizedObjectReader is not bound to this exact execution authority")
  })

  test("detaches provider rows before application code can mutate them", async () => {
    const at = new Date("2026-01-01T00:00:00.000Z")
    const providerRow: ObjectRow = {
      projectId,
      objectTypeId: Proposal.id,
      primaryId: "proposal-live-reference",
      properties: { id: "proposal-live-reference", title: "stored" },
      createdAt: at,
      updatedAt: at,
      version: 1,
      lastCommitId: "commit-1",
    }
    const backend = createReadStorage({ getByPrimaryId: async () => providerRow })
    const objectStorage = createObjectStorage(backend.storage, () => backend.storage)
    const reader = createAuthorizedObjectReader({
      scope: principalScope("detached", [Proposal.id]),
      ontology,
      objectStorage,
    })

    const returned = await reader.getByPrimaryId({
      objectTypeId: Proposal.id,
      primaryId: providerRow.primaryId,
    })
    expect(returned).not.toBe(providerRow)
    returned!.properties.title = "mutated-without-edit"

    // Removing detachReadResult reproduces the bug: this expectation becomes
    // "mutated-without-edit" because InMemoryObjectStorage also returns live references.
    expect(providerRow.properties.title).toBe("stored")
  })

  test("ignores runtime projectId extras and always injects the bound project", async () => {
    const backend = createReadStorage()
    const objectStorage = createObjectStorage(backend.storage, () => backend.storage)
    const reader = createAuthorizedObjectReader({
      scope: principalScope("project-bound", [Proposal.id]),
      ontology,
      objectStorage,
    })

    await reader.getByPrimaryId({
      objectTypeId: Proposal.id,
      primaryId: "proposal-1",
      projectId: "other-project",
    } as Parameters<AuthorizedObjectReader["getByPrimaryId"]>[0])
    await reader.executeQuery({
      query: { kind: "start", objectTypeId: Proposal.id },
      projectId: "other-project",
    } as Parameters<AuthorizedObjectReader["executeQuery"]>[0])

    expect(backend.calls.filter((call) => call.operation === "getByPrimaryId")).toEqual([
      {
        operation: "getByPrimaryId",
        input: { objectTypeId: Proposal.id, primaryId: "proposal-1", projectId },
      },
    ])
    expect(backend.calls.find((call) => call.operation === "queryObjects")?.input).toMatchObject({
      projectId,
    })
  })

  test("executes the exact query snapshot that was authorized", async () => {
    let objectTypeReads = 0
    const authoredQuery = Object.defineProperties(
      {},
      {
        kind: { enumerable: true, value: "start" },
        objectTypeId: {
          enumerable: true,
          get: () => (objectTypeReads++ === 0 ? Proposal.id : LineItem.id),
        },
      }
    ) as ObjectQuery
    const backend = createReadStorage({
      queryObjects: async (input) => ({
        objects: [rowForQuery(input.query)],
        hasMore: false,
        total: 1,
      }),
    })
    const objectStorage = createObjectStorage(backend.storage, () => backend.storage)
    const reader = createAuthorizedObjectReader({
      scope: principalScope("query-snapshot", [Proposal.id]),
      ontology,
      objectStorage,
    })

    const result = await reader.executeQuery({ query: authoredQuery })

    expect(objectTypeReads).toBe(1)
    expect(result.objects.map((row) => row.objectTypeId)).toEqual([Proposal.id])
    expect(backend.calls.find((call) => call.operation === "queryObjects")?.input).toMatchObject({
      query: { kind: "start", objectTypeId: Proposal.id },
    })
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
    access,
    delegation: { kind: "share", id: `share-${id}`, sessionId: `session-${id}` },
  })
}

function trustedScope(id: string): ExecutionScope {
  const primitive: TrustedPrimitiveRef = {
    kind: "action",
    id: `action-${id}`,
    runId: `run-${id}`,
  }
  const execution: ExecutionContext = Object.freeze({
    id: `execution-${id}`,
    projectId,
    executor: Object.freeze({ type: "primitive", ...primitive }),
    source: Object.freeze({ type: "event", eventId: `event-${id}` }),
    correlationId: `correlation-${id}`,
  })
  return Object.freeze({
    execution,
    authorization: createTrustedPrimitiveRuntimeAuthorization({ execution, primitive }),
  })
}

type ReadCall = {
  readonly operation: string
  readonly input?: unknown
}

function createReadStorage(
  input: {
    readonly getByPrimaryId?: ObjectReadStorage["getByPrimaryId"]
    readonly queryObjects?: NonNullable<ObjectReadStorage["queryObjects"]>
  } = {}
): { readonly storage: ObjectReadStorage; readonly calls: ReadCall[] } {
  const calls: ReadCall[] = []
  const record = (operation: string, operationInput?: unknown): void => {
    calls.push({ operation, ...(operationInput === undefined ? {} : { input: operationInput }) })
  }
  const capabilities: ObjectQueryCapabilities = {
    queryObjects: true,
    nodes: { start: true, traverse: true },
    traversalDirections: { outgoing: true, incoming: true },
  }

  return {
    calls,
    storage: {
      queryCapabilities() {
        record("queryCapabilities")
        return capabilities
      },
      async queryObjects(queryInput) {
        record("queryObjects", queryInput)
        return (
          input.queryObjects?.(queryInput) ??
          Promise.resolve({ objects: [], hasMore: false, total: 0 })
        )
      },
      async getByPrimaryId(getInput) {
        record("getByPrimaryId", getInput)
        return input.getByPrimaryId?.(getInput) ?? null
      },
      async getByPrimaryIdMany(batchInput) {
        record("getByPrimaryIdMany", batchInput)
        return batchInput.items.map(() => null)
      },
      async selectsObjectProperties(propertiesInput) {
        record("selectsObjectProperties", propertiesInput)
        return propertiesInput.items.map(() => true)
      },
      async listLinks(linksInput) {
        record("listLinks", linksInput)
        return []
      },
      async listLinksMany(linksInput) {
        record("listLinksMany", linksInput)
        return linksInput.items.map(() => [])
      },
      async list(listInput) {
        record("list", listInput)
        return { objects: [], hasMore: false, total: 0 }
      },
    },
  }
}

function rowForQuery(query: ObjectQuery): ObjectRow {
  if (query.kind !== "start") throw new Error("Expected a start query")
  const at = new Date("2026-01-01T00:00:00.000Z")
  return {
    projectId,
    objectTypeId: query.objectTypeId,
    primaryId: "query-result",
    properties: { id: "query-result" },
    createdAt: at,
    updatedAt: at,
    version: 1,
    lastCommitId: "commit-query",
  }
}

function createObjectStorage(
  direct: ObjectReadStorage,
  createReadScope: ObjectStorage["createReadScope"]
): ObjectStorage {
  return {
    ...direct,
    createReadScope,
    async getByPrimaryIdBatch() {
      return new Map<string, ObjectRow>()
    },
    async listLinksBatch() {
      return new Map()
    },
    async listIncidentLinksBatch() {
      return []
    },
    async listByPrimaryIdPage() {
      return { objects: [] }
    },
  }
}
