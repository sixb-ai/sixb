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
import type { RuntimeAccessPlan } from "../src/authorization/access-plan"
import { createDelegatedRequestScope, createTestingScope } from "../src/execution/scopes"
import type { RuntimeAuthorization } from "../src/execution/types"
import { createExposedOntologyCatalog } from "../src/objects/ontology-catalog"
import type { OntologyDefinitionCatalog } from "../src/ontology/registry"
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
    prop("privateProfile", valueTypeRef(PrivateProfile)),
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
    // Represents a definition that exists in the current registry but was not snapshotted in a
    // delegated grant. Removing the plan-based projection makes it appear in the shared catalog.
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
const catalogSubtypeReaders = defineGroup("catalog-subtype-readers")
const catalogBroadViewer = defineRole("catalog.broad-viewer", {
  grantedTo: [catalogReaders],
  grants: [can.view(every.object().except([HiddenRecord]))],
})
const catalogCustomerViewer = defineRole("catalog.customer-viewer", {
  grantedTo: [catalogSubtypeReaders],
  grants: [can.view(Customer)],
})

function createHost() {
  return new SixbHost({
    id: "object-catalog-authorization",
    ontology: [CatalogOntology],
    groups: [catalogReaders, catalogSubtypeReaders],
    roles: [catalogBroadViewer, catalogCustomerViewer],
    ...createTestRuntimeDeps(),
  })
}

function principalContext(host: ReturnType<typeof createHost>, groupIds: readonly string[]) {
  return resolveAuthorizationContext({
    principal: { type: "user", id: "catalog-user" },
    groupIds,
    roles: host.definitions.security.listResolvedRoles(),
  })
}

function tokenKeys(objectType: ObjectTypeWithPropertyTokens, tokenMap: "p" | "l"): string[] {
  const withTokens = objectType as ObjectTypeWithPropertyTokens & {
    readonly l: Readonly<Record<string, unknown>>
  }
  return Object.keys(withTokens[tokenMap]).sort()
}

describe("authority-scoped object catalog", () => {
  test("does not consult the registry for denied authority", () => {
    const throwingOntology = new Proxy(
      {},
      {
        get() {
          throw new Error("denied catalog consulted the ontology")
        },
      }
    ) as OntologyDefinitionCatalog

    const deniedExecution = createTestingScope({ projectId: "denied-project" }).execution
    const catalog = createExposedOntologyCatalog(
      {
        projectId: "denied-project",
        runtimeAuthorization: {} as RuntimeAuthorization,
        ontology: throwingOntology,
      },
      deniedExecution
    )

    expect(catalog.listObjectTypes()).toEqual([])
    expect(catalog.getObjectTypeById(Proposal.id)).toBeNull()
    expect(catalog.getValueTypesById().size).toBe(0)
    expect(catalog.listSubTypes(Proposal.id)).toEqual([])
    expect(catalog.isValidLinkTarget("*", Proposal.id)).toBe(false)
    expect(() => catalog.resolveObjectType(Proposal.id)).toThrow("Unknown object type")
    expect(() => catalog.getPrimaryPropertyId(Proposal.id)).toThrow("Unknown object type")
  })

  test("rejects recombining registered authority with another same-project execution", () => {
    const scope = createTestingScope({ projectId: "catalog-binding-project" })
    const throwingOntology = new Proxy(
      {},
      {
        get() {
          throw new Error("mismatched catalog consulted the ontology")
        },
      }
    ) as OntologyDefinitionCatalog

    expect(() =>
      createExposedOntologyCatalog(
        {
          projectId: scope.execution.projectId,
          runtimeAuthorization: scope.authorization,
          ontology: throwingOntology,
        },
        { ...scope.execution, id: "another-execution" }
      )
    ).toThrow("authority is bound to different execution provenance")
  })

  test("projects principal types, link endpoints, subtype metadata, and referenced ValueTypes", () => {
    const host = createHost()
    const sixb = createTestSixb(host, {
      authorization: principalContext(host, [catalogReaders.id]),
    })

    expect(sixb.objects.listTypes().map((objectType) => objectType.id)).toEqual([
      Proposal.id,
      Customer.id,
      PremiumCustomer.id,
    ])
    expect(sixb.objects.getTypeById(HiddenRecord.id)).toBeNull()
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
      [Address.id, CustomerProfile.id, EdgeNote.id, PrivateEdgeNote.id, PrivateProfile.id].sort()
    )
    expect(sixb.objects.getValueTypesById().has(HiddenOnlyValue.id)).toBe(false)
  })

  test("uses the same subtype-expanded principal grants as protected leaves", () => {
    const host = createHost()
    const sixb = createTestSixb(host, {
      authorization: principalContext(host, [catalogSubtypeReaders.id]),
    })

    expect(sixb.objects.listTypes().map((objectType) => objectType.id)).toEqual([
      Customer.id,
      PremiumCustomer.id,
    ])
  })

  test("derives delegated schema only from the snapshotted access plan", () => {
    const host = createHost()
    const access: RuntimeAccessPlan = {
      grants: [
        {
          kind: "object.view",
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
                      ],
                      target: {
                        objects: [{ objectTypeId: Customer.id, propertyIds: ["id", "label"] }],
                        links: [],
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    }
    const shared = host.withScope(
      createDelegatedRequestScope({
        projectId: host.id,
        requestId: "shared-catalog-request",
        correlationId: "shared-catalog-correlation",
        access,
        delegation: { kind: "share", id: "catalog-share", sessionId: "catalog-session" },
      })
    )

    // Guard proof: temporarily returning the host registry for delegated authority makes this
    // assertion include PremiumCustomer and HiddenRecord, and the test fails before field checks.
    expect(shared.objects.listTypes().map((objectType) => objectType.id)).toEqual([
      Proposal.id,
      Customer.id,
    ])
    expect(shared.objects.getTypeById(HiddenRecord.id)).toBeNull()
    expect(shared.objects.getTypeById(PremiumCustomer.id)).toBeNull()

    const proposal = shared.objects.resolveType(Proposal.id)
    expect(proposal.properties.map((property) => property.id)).toEqual([
      "id",
      "title",
      "customerProfile",
    ])
    expect(proposal.search).toEqual({ title: "title", defaultText: ["title"], exact: [] })
    expect(proposal.links.map((candidate) => candidate.id)).toEqual(["customer"])
    expect(proposal.links[0]?.targetObjectTypeId).toBe(Customer.id)
    expect(proposal.links[0]?.properties?.map((property) => property.id)).toEqual(["note"])
    expect(tokenKeys(proposal, "p")).toEqual(["customerProfile", "id", "title"])
    expect(tokenKeys(proposal, "l")).toEqual(["customer"])
    expect(shared.objects.getPrimaryPropertyId(Proposal.id)).toBe("id")
    expect(shared.objects.isValidLinkTarget(Customer.id, Customer.id)).toBe(true)
    expect(shared.objects.isValidLinkTarget("*", HiddenRecord.id)).toBe(false)

    expect([...shared.objects.getValueTypesById().keys()].sort()).toEqual(
      [Address.id, CustomerProfile.id, EdgeNote.id].sort()
    )
    expect(shared.objects.getValueTypesById().has(PrivateProfile.id)).toBe(false)
    expect(shared.objects.getValueTypesById().has(PrivateEdgeNote.id)).toBe(false)
    expect(shared.objects.getValueTypesById().has(UnusedValue.id)).toBe(false)

    const registeredProposal = host.definitions.ontology.resolveObjectType(Proposal.id)
    const projectedValues = shared.objects.getValueTypesById()
    const projectedAddress = projectedValues.get(Address.id)
    if (!projectedAddress) throw new Error("Expected projected Address ValueType")

    expect(proposal).not.toBe(registeredProposal)
    expect(proposal.properties[0]).not.toBe(registeredProposal.properties[0])
    expect(proposal.links[0]).not.toBe(registeredProposal.links[0])
    expect(Object.isFrozen(proposal)).toBe(true)
    expect(Object.isFrozen(proposal.properties)).toBe(true)
    expect(Object.isFrozen(projectedAddress)).toBe(true)
    expect(() => {
      proposal.properties[0]!.name = "tampered"
    }).toThrow()
    expect(() => {
      ;(projectedValues as Map<string, typeof Address>).set("tampered", Address)
    }).toThrow("[Sixb] Scoped ontology catalog is immutable.")
    expect(() => {
      projectedAddress.name = "tampered"
    }).toThrow()

    expect(shared.objects.resolveType(Proposal.id).properties[0]?.name).toBe("id")
    expect(registeredProposal.properties[0]?.name).toBe("id")
    expect(host.definitions.ontology.getValueTypesById().get(Address.id)?.name).toBe("Address")
  })

  test("detaches the complete unrestricted catalog too", () => {
    const host = createHost()
    const sixb = createTestSixb(host)
    const projected = sixb.objects.resolveType(Proposal.id)
    const registered = host.definitions.ontology.resolveObjectType(Proposal.id)

    expect(projected).not.toBe(registered)
    expect(Object.isFrozen(projected)).toBe(true)
    expect(sixb.objects.getValueTypesById().has(UnusedValue.id)).toBe(true)
    expect(() => {
      projected.name = "tampered"
    }).toThrow()
    expect(registered.name).toBe("Proposal")
  })
})
