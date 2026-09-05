import { describe, expect, test } from "bun:test"
import {
  can,
  defineGroup,
  defineObjectType,
  defineOntology,
  defineRole,
  defineValueType,
  every,
  link,
  type ObjectTypeWithPropertyTokens,
  prop,
  resolveAuthorizationContext,
  SixbHost,
  valueTypeRef,
} from "../src"
import {
  createAuthorizedObjectReader,
  getAuthorizedOntologyView,
} from "../src/execution/authorized-object-reader"
import { createDelegatedRequestScope } from "../src/execution/scopes"
import { createAuthorizedOntologyView } from "../src/objects/authorized-ontology-view"
import { createObjectsRuntime } from "../src/objects/execution"
import { OntologyRegistry } from "../src/ontology"
import { registerOntologyMutationRuntime } from "../src/runtime/ontology-mutations"
import type { SixbRuntimeContext } from "../src/runtime/types"
import { InMemoryObjectStorage } from "../src/storage/objects/in-memory"
import type { CompiledSelectedObjectReadScope } from "../src/storage/objects/types"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Address = defineValueType({
  id: "catalog:Address",
  name: "Address",
  schema: {
    type: "object",
    properties: { city: { required: true, schema: "string" } },
  },
})

const CustomerProfile = defineValueType({
  id: "catalog:CustomerProfile",
  name: "Customer profile",
  schema: {
    type: "object",
    properties: { address: { required: true, schema: valueTypeRef(Address) } },
  },
})

const PrivateProfile = defineValueType({
  id: "catalog:PrivateProfile",
  name: "Private profile",
  schema: "string",
})

const EdgeNote = defineValueType({
  id: "catalog:EdgeNote",
  name: "Edge note",
  schema: "string",
})

const PrivateEdgeNote = defineValueType({
  id: "catalog:PrivateEdgeNote",
  name: "Private edge note",
  schema: "string",
})

const UnusedValue = defineValueType({
  id: "catalog:Unused",
  name: "Unused",
  schema: "string",
})

const HiddenOnlyValue = defineValueType({
  id: "catalog:HiddenOnly",
  name: "Hidden only",
  schema: "string",
})

const Customer = defineObjectType({
  id: "CatalogCustomer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("label", "string"),
    prop("privateProfile", valueTypeRef(PrivateProfile)),
  ],
})

const PremiumCustomer = defineObjectType({
  id: "CatalogPremiumCustomer",
  name: "Premium customer",
  extends: Customer,
  properties: [prop("tier", "string")],
})

const HiddenRecord = defineObjectType({
  id: "CatalogHiddenRecord",
  name: "Hidden record",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("hiddenOnly", valueTypeRef(HiddenOnlyValue)),
  ],
})

const Proposal = defineObjectType({
  id: "CatalogProposal",
  name: "Proposal",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { query: { searchable: true, text: true } }),
    prop("customerProfile", valueTypeRef(CustomerProfile)),
    prop("secret", valueTypeRef(PrivateProfile), {
      query: { searchable: true, exact: true, text: true },
    }),
  ],
  search: {
    title: "title",
    defaultText: ["title", "secret"],
    exact: ["secret"],
  },
  links: [
    link("customer", Customer, {
      properties: [
        prop("note", valueTypeRef(EdgeNote)),
        prop("privateNote", valueTypeRef(PrivateEdgeNote)),
      ],
    }),
    link("addedAfterIssuance", Customer),
    link("hiddenRecord", HiddenRecord),
    link.any("mixedTarget", {
      properties: [prop("note", valueTypeRef(EdgeNote))],
    }),
  ],
})

const CatalogOntology = defineOntology({
  id: "catalog-tests",
  version: "1.0.0",
  objectTypes: [Proposal, Customer, PremiumCustomer, HiddenRecord],
  valueTypes: [
    Address,
    CustomerProfile,
    PrivateProfile,
    EdgeNote,
    PrivateEdgeNote,
    UnusedValue,
    HiddenOnlyValue,
  ],
})

const catalogReaders = defineGroup("catalog-readers")
const catalogViewer = defineRole("catalog.viewer", {
  grantedTo: [catalogReaders],
  grants: [can.view(every.object().except([HiddenRecord]))],
})

function createHost() {
  return new SixbHost({
    id: "authorized-ontology-view",
    ontology: [CatalogOntology],
    groups: [catalogReaders],
    roles: [catalogViewer],
    ...createTestRuntimeDeps(),
  })
}

function createDelegatedCatalogScope(
  maxOutputJsonBytes = 1_000_000,
  options: { readonly includePremiumRoot?: boolean } = {}
) {
  return createDelegatedRequestScope({
    projectId: "delegated-catalog",
    requestId: "delegated-catalog-request",
    correlationId: "delegated-catalog-correlation",
    objectRead: {
      selection: {
        kind: "selected",
        roots: [
          {
            anchor: { objectTypeId: Proposal.id, primaryId: "proposal-1" },
            node: {
              objects: [
                {
                  objectTypeId: Proposal.id,
                  propertyIds: ["id", "title", "customerProfile"],
                },
              ],
              links: [
                {
                  definitions: [
                    {
                      sourceObjectTypeId: Proposal.id,
                      linkId: Proposal.l.customer.id,
                      targetObjectTypeIds: [Customer.id],
                      propertyIds: ["note"],
                    },
                    {
                      sourceObjectTypeId: Proposal.id,
                      linkId: Proposal.l.mixedTarget.id,
                      targetObjectTypeIds: [Customer.id],
                      propertyIds: [],
                    },
                  ],
                  target: {
                    objects: [{ objectTypeId: Customer.id, propertyIds: ["id", "label"] }],
                    links: [],
                  },
                },
              ],
            },
          },
          ...(options.includePremiumRoot
            ? [
                {
                  anchor: {
                    objectTypeId: PremiumCustomer.id,
                    primaryId: "premium-customer-1",
                  },
                  node: {
                    objects: [{ objectTypeId: PremiumCustomer.id, propertyIds: ["tier"] }],
                    links: [],
                  },
                },
              ]
            : []),
        ],
      },
      limits: { maxTraversalFacts: 100, maxOutputJsonBytes },
    },
  })
}

function tokenKeys(objectType: ObjectTypeWithPropertyTokens, tokenMap: "p" | "l"): string[] {
  const tokens = objectType as ObjectTypeWithPropertyTokens & {
    readonly l: Readonly<Record<string, unknown>>
  }
  return Object.keys(tokens[tokenMap]).sort()
}

function createSelectedView(
  ontology: OntologyRegistry,
  objects: CompiledSelectedObjectReadScope["objects"],
  steps: CompiledSelectedObjectReadScope["steps"] = []
) {
  return createAuthorizedOntologyView({
    ontology,
    selection: { kind: "selected", scope: { kind: "selected", roots: [], objects, steps } },
  })
}

describe("authorized ontology view", () => {
  test("projects principal types and endpoints while preserving the ValueType catalog", () => {
    const host = createHost()
    const authorization = resolveAuthorizationContext({
      principal: { type: "user", id: "catalog-user" },
      groupIds: [catalogReaders.id],
      roles: host.definitions.security.listResolvedRoles(),
    })
    const sixb = createTestSixb(host, { authorization })

    expect(sixb.objects.listTypes().map((objectType) => objectType.id)).toEqual([
      Proposal.id,
      Customer.id,
      PremiumCustomer.id,
    ])
    expect(sixb.objects.getTypeById(HiddenRecord.id)).toBeNull()
    expect(() => sixb.objects.resolveType(HiddenRecord.id)).toThrow("Unknown object type")
    expect(sixb.objects.listSubTypes(Customer.id)).toEqual([PremiumCustomer.id])
    expect(sixb.objects.listSubTypes(HiddenRecord.id)).toEqual([])
    expect(sixb.objects.isValidLinkTarget(Customer.id, PremiumCustomer.id)).toBe(true)
    expect(sixb.objects.isValidLinkTarget("*", HiddenRecord.id)).toBe(false)

    const proposal = sixb.objects.resolveType(Proposal.id)
    expect(proposal.links.map((candidate) => candidate.id)).toEqual([
      "customer",
      "addedAfterIssuance",
      "mixedTarget",
    ])
    expect(proposal.links.find((candidate) => candidate.id === "hiddenRecord")).toBeUndefined()
    expect(
      proposal.links.find((candidate) => candidate.id === "mixedTarget")?.targetObjectTypeId
    ).toEqual([Customer.id, PremiumCustomer.id, Proposal.id])
    expect(tokenKeys(proposal, "l")).toEqual(["addedAfterIssuance", "customer", "mixedTarget"])

    expect([...sixb.objects.getValueTypesById().keys()].sort()).toEqual(
      [
        Address,
        CustomerProfile,
        PrivateProfile,
        EdgeNote,
        PrivateEdgeNote,
        UnusedValue,
        HiddenOnlyValue,
      ]
        .map((valueType) => valueType.id)
        .sort()
    )
  })

  test("derives delegated metadata only from the captured selected scope", () => {
    const ontology = new OntologyRegistry({ sources: [CatalogOntology] })
    const reader = createAuthorizedObjectReader({
      scope: createDelegatedCatalogScope(),
      ontology,
      objectStorage: new InMemoryObjectStorage(),
    })
    const view = getAuthorizedOntologyView(reader)

    // Regression proof: projecting the complete registry for delegated authority makes this
    // include PremiumCustomer and HiddenRecord before the field-level assertions run.
    expect(view.listObjectTypes().map((objectType) => objectType.id)).toEqual([
      Proposal.id,
      Customer.id,
    ])
    expect(view.getObjectTypeById(HiddenRecord.id)).toBeNull()
    expect(view.getObjectTypeById(PremiumCustomer.id)).toBeNull()

    const proposal = view.resolveObjectType(Proposal.id)
    expect(proposal.properties.map((property) => property.id)).toEqual([
      "id",
      "title",
      "customerProfile",
    ])
    expect(proposal.search).toEqual({ title: "title", defaultText: ["title"] })
    expect(proposal.links.map((candidate) => candidate.id)).toEqual(["customer", "mixedTarget"])
    expect(proposal.links[0]?.targetObjectTypeId).toBe(Customer.id)
    expect(proposal.links[0]?.properties?.map((property) => property.id)).toEqual(["note"])
    expect(proposal.links[1]?.targetObjectTypeId).toBe(Customer.id)
    expect(proposal.links[1]?.properties).toBeUndefined()
    expect(tokenKeys(proposal, "p")).toEqual(["customerProfile", "id", "title"])
    expect(tokenKeys(proposal, "l")).toEqual(["customer", "mixedTarget"])
    expect(view.getPrimaryPropertyId(Proposal.id)).toBe("id")
    const customerSubTypes = view.listSubTypes(Customer.id)
    expect(customerSubTypes).toEqual([])
    customerSubTypes.push(PremiumCustomer.id)
    expect(view.listSubTypes(Customer.id)).toEqual([])
    expect(view.isValidLinkTarget("*", HiddenRecord.id)).toBe(false)

    expect([...view.getValueTypesById().keys()].sort()).toEqual(
      [Address.id, CustomerProfile.id, EdgeNote.id].sort()
    )
    expect(view.getValueTypesById().has(PrivateProfile.id)).toBe(false)
    expect(view.getValueTypesById().has(PrivateEdgeNote.id)).toBe(false)
    expect(view.getValueTypesById().has(UnusedValue.id)).toBe(false)

    const registeredProposal = ontology.resolveObjectType(Proposal.id)
    const projectedValues = view.getValueTypesById()
    const projectedAddress = projectedValues.get(Address.id)
    if (!projectedAddress) throw new Error("Expected projected Address ValueType")
    expect(proposal).not.toBe(registeredProposal)
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.isFrozen(proposal)).toBe(false)
    proposal.properties[0]!.name = "tampered"
    expect(view.resolveObjectType(Proposal.id).properties[0]?.name).toBe("id")
    expect(projectedValues).toBeInstanceOf(Map)
    expect(structuredClone(projectedValues)).toEqual(projectedValues)
    ;(projectedValues as Map<string, typeof Address>).set("tampered", Address)
    expect(view.getValueTypesById().has("tampered")).toBe(false)
    ;(view.listObjectTypes() as ObjectTypeWithPropertyTokens[]).push(HiddenRecord)
    expect(view.listObjectTypes().map((objectType) => objectType.id)).toEqual([
      Proposal.id,
      Customer.id,
    ])
    expect(ontology.resolveObjectType(Proposal.id).properties[0]?.name).toBe("id")
  })

  test("enforces the delegated output budget on every metadata terminal", () => {
    const ontology = new OntologyRegistry({ sources: [CatalogOntology] })
    const reader = createAuthorizedObjectReader({
      scope: createDelegatedCatalogScope(1),
      ontology,
      objectStorage: new InMemoryObjectStorage(),
    })
    const view = getAuthorizedOntologyView(reader)
    const expectBudgetExceeded = (read: () => unknown) => {
      expect(read).toThrow(
        expect.objectContaining({
          code: "object_read_limit_exceeded",
          metric: "outputJsonBytes",
          limit: 1,
        })
      )
    }

    // Regression proof: removing the delegated release guard makes this metadata read succeed.
    expectBudgetExceeded(() => view.listObjectTypes())
    expectBudgetExceeded(() => view.getObjectTypeById(Proposal.id))
    expectBudgetExceeded(() => view.resolveObjectType(Proposal.id))
    expectBudgetExceeded(() => view.getValueTypesById())
    expectBudgetExceeded(() => view.getPrimaryPropertyId(Proposal.id))
    expectBudgetExceeded(() => view.listSubTypes(Customer.id))
    expectBudgetExceeded(() => view.isValidLinkTarget(Customer.id, Customer.id))

    const mapReader = createAuthorizedObjectReader({
      scope: createDelegatedCatalogScope(16),
      ontology,
      objectStorage: new InMemoryObjectStorage(),
    })
    // Regression proof: budgeting the native Map itself serializes `{}` and bypasses this bound;
    // the released representation must include its entries.
    expect(() => getAuthorizedOntologyView(mapReader).getValueTypesById()).toThrow(
      expect.objectContaining({
        code: "object_read_limit_exceeded",
        metric: "outputJsonBytes",
        limit: 16,
      })
    )
  })

  test("keeps selected link targets exact even when a subtype is visible elsewhere", () => {
    const ontology = new OntologyRegistry({ sources: [CatalogOntology] })
    const reader = createAuthorizedObjectReader({
      scope: createDelegatedCatalogScope(1_000_000, { includePremiumRoot: true }),
      ontology,
      objectStorage: new InMemoryObjectStorage(),
    })
    const view = getAuthorizedOntologyView(reader)

    expect(view.getObjectTypeById(PremiumCustomer.id)).not.toBeNull()
    expect(view.isValidLinkTarget(Customer.id, PremiumCustomer.id)).toBe(false)
    expect(view.isValidLinkTarget([Customer.id, PremiumCustomer.id], PremiumCustomer.id)).toBe(true)
  })

  test("unions repeated selected definitions in deterministic ontology order", () => {
    const ontology = new OntologyRegistry({ sources: [CatalogOntology] })
    const view = createSelectedView(
      ontology,
      [
        { nodeId: 2, objectTypeId: Proposal.id, propertyIds: ["title"] },
        { nodeId: 1, objectTypeId: Proposal.id, propertyIds: ["id"] },
        { nodeId: 4, objectTypeId: PremiumCustomer.id, propertyIds: ["tier"] },
        { nodeId: 3, objectTypeId: Customer.id, propertyIds: ["id"] },
      ],
      [
        {
          nodeId: 4,
          parentNodeId: 1,
          sourceObjectTypeId: Proposal.id,
          linkId: Proposal.l.customer.id,
          targetObjectTypeId: PremiumCustomer.id,
          propertyIds: ["privateNote"],
        },
        {
          nodeId: 3,
          parentNodeId: 1,
          sourceObjectTypeId: Proposal.id,
          linkId: Proposal.l.customer.id,
          targetObjectTypeId: Customer.id,
          propertyIds: ["note"],
        },
      ]
    )

    expect(view.listObjectTypes().map((objectType) => objectType.id)).toEqual([
      Proposal.id,
      Customer.id,
      PremiumCustomer.id,
    ])
    const proposal = view.resolveObjectType(Proposal.id)
    expect(proposal.properties.map((property) => property.id)).toEqual(["id", "title"])
    expect(proposal.links[0]?.targetObjectTypeId).toEqual([Customer.id, PremiumCustomer.id])
    expect(proposal.links[0]?.properties?.map((property) => property.id)).toEqual([
      "note",
      "privateNote",
    ])
  })

  test("intersects stale selections with the current ontology and keeps writes closed", () => {
    const ontology = new OntologyRegistry({ sources: [CatalogOntology] })
    const view = createSelectedView(
      ontology,
      [
        {
          nodeId: 1,
          objectTypeId: Proposal.id,
          propertyIds: ["title", "removedProperty"],
        },
        { nodeId: 2, objectTypeId: Customer.id, propertyIds: ["id"] },
        { nodeId: 3, objectTypeId: "RemovedType", propertyIds: ["id"] },
      ],
      [
        {
          nodeId: 2,
          parentNodeId: 1,
          sourceObjectTypeId: Proposal.id,
          linkId: Proposal.l.customer.id,
          targetObjectTypeId: Customer.id,
          propertyIds: ["removedEdgeProperty"],
        },
        {
          nodeId: 2,
          parentNodeId: 1,
          sourceObjectTypeId: Proposal.id,
          linkId: "removedLink",
          targetObjectTypeId: Customer.id,
          propertyIds: [],
        },
      ]
    )

    const proposal = view.resolveObjectType(Proposal.id)
    expect(proposal.properties.map((property) => property.id)).toEqual(["title"])
    expect(proposal.links).toEqual([
      expect.objectContaining({
        id: "customer",
        targetObjectTypeId: Customer.id,
        properties: undefined,
      }),
    ])
    expect(view.getObjectTypeById("RemovedType")).toBeNull()
    expect(() => view.resolveObjectType("RemovedType")).toThrow("Unknown object type")
    expect(() => view.getPrimaryPropertyId(Proposal.id)).toThrow(
      "does not expose its primary property"
    )
  })

  test("hides parent classification and incomplete vector search metadata", () => {
    const SearchDocument = defineObjectType({
      id: "SearchDocument",
      name: "Search document",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("title", "string", { query: { searchable: true, text: true } }),
        prop("secret", "string", { query: { searchable: true, text: true } }),
        prop(
          "embedding",
          { type: "array", items: "double" },
          {
            query: { searchable: true, vector: true },
          }
        ),
      ],
      search: {
        title: "title",
        vector: { property: "embedding", source: ["title", "secret"] },
      },
    })
    const ontology = new OntologyRegistry({ sources: [CatalogOntology, SearchDocument] })
    const view = createSelectedView(ontology, [
      { nodeId: 1, objectTypeId: PremiumCustomer.id, propertyIds: ["tier"] },
      {
        nodeId: 2,
        objectTypeId: SearchDocument.id,
        propertyIds: ["id", "title", "embedding"],
      },
    ])

    const premium = view.resolveObjectType(PremiumCustomer.id)
    expect(premium.extends).toBeUndefined()
    expect(premium.parents).toBeUndefined()
    expect(view.listSubTypes(Customer.id)).toEqual([])
    expect(view.isValidLinkTarget(Customer.id, PremiumCustomer.id)).toBe(false)
    expect(view.resolveObjectType(SearchDocument.id).search).toEqual({ title: "title" })
  })

  test("pins one authorized reader across every object facade terminal", async () => {
    const host = createHost()
    const ontology = new OntologyRegistry({ sources: [CatalogOntology] })
    const scope = createDelegatedCatalogScope()
    const reader = createAuthorizedObjectReader({
      scope,
      ontology,
      objectStorage: host.storage.objects,
    })
    let objectReaderReads = 0
    const runtime = {
      projectId: scope.execution.projectId,
      broker: host.broker,
      ontology,
      actionRegistry: host.definitions.actions,
      events: host.events,
      storage: host.storage,
      queues: host.queues,
      runtimeAuthorization: scope.authorization,
      get objectReader() {
        objectReaderReads += 1
        if (objectReaderReads > 1) {
          throw new Error("Object facade re-read its authority after binding.")
        }
        return reader
      },
    } satisfies SixbRuntimeContext
    const unavailableMutation = async (): Promise<never> => {
      throw new Error("Mutation is unavailable in this read-only test.")
    }
    registerOntologyMutationRuntime(runtime, {
      commitEdits: unavailableMutation,
      replaceProjection: unavailableMutation,
      finishProjection: unavailableMutation,
      appendTelemetry: unavailableMutation,
    })

    // Regression proof: reconstructing the runtime with `{ ...runtime }` after binding reads the
    // accessor a second time before any terminal runs and fails this test.
    const objects = createObjectsRuntime<readonly [typeof CatalogOntology]>(
      runtime,
      scope.execution
    )
    const proposals = objects(Proposal)

    expect(await proposals.get("proposal-1")).toBeNull()
    expect((await proposals.list()).objects).toEqual([])
    expect((await proposals.query().list()).objects).toEqual([])
    expect((await objects.list({ objectTypeIds: [Proposal.id] })).objects).toEqual([])
    expect(objects.listTypes().map((objectType) => objectType.id)).toEqual([
      Proposal.id,
      Customer.id,
    ])
    expect(objectReaderReads).toBe(1)
  })

  test("detaches the unrestricted catalog while preserving complete metadata", () => {
    const host = createHost()
    const sixb = createTestSixb(host)
    const projected = sixb.objects.resolveType(Proposal.id)
    const registered = host.definitions.ontology.resolveObjectType(Proposal.id)

    expect(sixb.objects.listTypes()).toHaveLength(4)
    expect(sixb.objects.getValueTypesById().has(UnusedValue.id)).toBe(true)
    expect(projected).not.toBe(registered)
    projected.name = "tampered"
    expect(sixb.objects.resolveType(Proposal.id).name).toBe("Proposal")
    expect(registered.name).toBe("Proposal")
  })

  test("preserves unresolved link references for unrestricted execution", () => {
    const ExternalOwner = defineObjectType({
      id: "ExternalOwner",
      name: "External owner",
      properties: [prop("id", "string", { required: true, primary: true })],
      links: [link.ref("external", "External")],
    })
    const ontology = new OntologyRegistry({ sources: [ExternalOwner] })
    const view = createAuthorizedOntologyView({ ontology, selection: { kind: "all" } })

    expect(view.resolveObjectType(ExternalOwner.id).links).toEqual([
      expect.objectContaining({ id: "external", targetObjectTypeId: "External" }),
    ])
    expect(view.isValidLinkTarget("External", "External")).toBe(true)
  })
})
