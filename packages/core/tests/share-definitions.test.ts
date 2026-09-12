import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
  can,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  defineShare,
  defineValueType,
  link,
  type OntologySource,
  objectRef,
  param,
  prop,
  ref,
  ShareDefinitionError,
  type ValueType,
  valueTypeRef,
} from "../src"
import { ActionRegistry } from "../src/actions"
import { OntologyRegistry } from "../src/ontology"
import { SecurityRegistry } from "../src/security"
import {
  compileShareAccessPlan,
  intersectShareAccessPlans,
  validateSharesAtStartup,
} from "../src/shares"

const Customer = defineObjectType({
  id: "customer",
  name: "Customer",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

const Product = defineObjectType({
  id: "product",
  name: "Product",
  properties: [prop("id", "string", { required: true, primary: true }), prop("label", "string")],
})

const LineItem = defineObjectType({
  id: "line-item",
  name: "Line item",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("quantity", "integer"),
  ],
  links: [link("product", Product)],
})

const Proposal = defineObjectType({
  id: "proposal",
  name: "Proposal",
  properties: [prop("id", "string", { required: true, primary: true }), prop("title", "string")],
  links: [
    link("customer", Customer),
    link("items", LineItem, {
      cardinality: "many",
      properties: [prop("position", "integer")],
    }),
  ],
})

const approveProposal = defineAction("approve-proposal")
  .on(Proposal)
  .params({})
  .writeback(async () => {})

const GlobalRefresh = defineAction("global-refresh")
  .params({})
  .writeback(async () => {})

const ProposalShare = defineShare("proposal", {
  target: Proposal,
  grants: ({ target }) => [
    can
      .view(target)
      .withLinks([Proposal.l.customer, Proposal.l.items.withLinks([LineItem.l.product])]),
    can.apply(approveProposal).on(target),
  ],
})

function runtimeFor(
  objectTypes: readonly OntologySource[] = [Customer, Product, LineItem, Proposal],
  actions: readonly ActionDefinition[] = [approveProposal, GlobalRefresh]
) {
  const ontology = new OntologyRegistry({ sources: objectTypes })
  return {
    ontology,
    actions: new ActionRegistry({ actions, ontology }),
  }
}

function viewGrant(plan: ReturnType<typeof compileShareAccessPlan>) {
  const grant = plan.grants.find((candidate) => candidate.kind === "object.view")
  if (!grant || grant.kind !== "object.view") throw new Error("missing view grant")
  return grant
}

describe("Share definitions", () => {
  test("captures contextual grants as an inert ids-only definition", () => {
    expect(ProposalShare).toMatchObject({
      kind: "share",
      id: "proposal",
      target: { kind: "object", objectTypeId: "proposal" },
      grants: [
        { kind: "object.view", targetObjectTypeId: "proposal" },
        {
          kind: "action.apply",
          actionId: "approve-proposal",
          subjectObjectTypeId: "proposal",
        },
      ],
    })
    expect(structuredClone(ProposalShare)).toEqual(ProposalShare)
    expect(Object.keys(can.apply(approveProposal))).toEqual(["kind", "capability", "selection"])
  })

  test("keeps the existing role grant builders intact", () => {
    expect(can.view(Proposal)).toEqual({
      kind: "grant",
      capability: "view",
      target: "object",
      selection: { all: false, ids: ["proposal"] },
    })
    expect(can.apply(approveProposal)).toMatchObject({
      kind: "grant",
      capability: "apply",
      selection: { all: false, ids: ["approve-proposal"] },
    })
    expect(can.share(ProposalShare)).toEqual({
      kind: "grant",
      capability: "share",
      selection: { all: false, ids: ["proposal"] },
    })
  })

  test("compiles exact roots, property snapshots, link paths, and Action subjects", () => {
    const runtime = runtimeFor()
    const target = objectRef(Proposal, "proposal-1")
    const plan = compileShareAccessPlan({ share: ProposalShare, target, ...runtime })

    expect(plan.grants.find((grant) => grant.kind === "action.apply")).toEqual({
      kind: "action.apply",
      actionId: "approve-proposal",
      subjects: [target],
    })

    const root = viewGrant(plan).selection.roots[0]
    expect(root?.anchor).toEqual(target)
    expect(root?.node.objects).toEqual([{ objectTypeId: "proposal", propertyIds: ["id", "title"] }])
    const items = root?.node.links.find((candidate) =>
      candidate.definitions.some((definition) => definition.linkId === "items")
    )
    expect(items?.definitions).toEqual([
      {
        sourceObjectTypeId: "proposal",
        linkId: "items",
        targetObjectTypeIds: ["line-item"],
        propertyIds: ["position"],
      },
    ])
    expect(items?.target.objects).toEqual([
      { objectTypeId: "line-item", propertyIds: ["id", "quantity"] },
    ])
    expect(items?.target.links[0]?.definitions[0]).toMatchObject({
      sourceObjectTypeId: "line-item",
      linkId: "product",
      targetObjectTypeIds: ["product"],
    })
  })

  test("withLinks() expands direct links only", () => {
    const share = defineShare("all-direct", {
      target: Proposal,
      grants: ({ target }) => [can.view(target).withLinks()],
    })
    const plan = compileShareAccessPlan({
      share,
      target: objectRef(Proposal, "proposal-1"),
      ...runtimeFor(),
    })
    const links = viewGrant(plan).selection.roots[0]?.node.links ?? []
    expect(
      links.flatMap((item) => item.definitions.map((definition) => definition.linkId))
    ).toEqual(["customer", "items"])
    expect(links.every((item) => item.target.links.length === 0)).toBe(true)
  })

  test("withLinks() canonicalizes inherited links on polymorphic targets", () => {
    const Base = defineObjectType({
      id: "polymorphic-base",
      name: "Polymorphic base",
      properties: [prop("id", "string", { required: true, primary: true })],
      links: [link("product", Product)],
    })
    const Child = defineObjectType({
      id: "polymorphic-child",
      name: "Polymorphic child",
      extends: Base,
      properties: [],
    })
    const Root = defineObjectType({
      id: "polymorphic-root",
      name: "Polymorphic root",
      properties: [prop("id", "string", { required: true, primary: true })],
      links: [link("targets", Base)],
    })
    const share = defineShare("polymorphic-links", {
      target: Root,
      grants: ({ target }) => [can.view(target).withLinks([Root.l.targets.withLinks()])],
    })
    const runtime = runtimeFor([Product, Base, Child, Root], [])
    const plan = compileShareAccessPlan({
      share,
      target: objectRef(Root, "root-1"),
      ...runtime,
    })
    const target = viewGrant(plan).selection.roots[0]?.node.links[0]?.target

    expect(target?.links).toHaveLength(1)
    expect(
      target?.links[0]?.definitions.map((definition) => definition.sourceObjectTypeId)
    ).toEqual(["polymorphic-base", "polymorphic-child"])
  })

  test("canonicalizes duplicate link selections before snapshot and intersection", () => {
    const share = defineShare("deduplicated-links", {
      target: Proposal,
      grants: ({ target }) => [
        can.view(target).withLinks(Array.from({ length: 23 }, () => Proposal.l.items)),
      ],
    })
    const plan = compileShareAccessPlan({
      share,
      target: objectRef(Proposal, "proposal-1"),
      ...runtimeFor(),
    })

    expect(viewGrant(plan).selection.roots[0]?.node.links).toHaveLength(1)
    expect(intersectShareAccessPlans(plan, plan)).toEqual(plan)
  })

  test("rejects empty selections and inherited/global shared Actions early", () => {
    expect(() =>
      defineShare("empty-links", {
        target: Proposal,
        grants: ({ target }) => [can.view(target).withLinks([])],
      })
    ).toThrow("withLinks([]) is empty")
    expect(() =>
      defineShare("empty-nested-links", {
        target: Proposal,
        grants: ({ target }) => [can.view(target).withLinks([Proposal.l.items.withLinks([])])],
      })
    ).toThrow(ShareDefinitionError)

    const SpecializedProposal = defineObjectType({
      id: "specialized-proposal",
      name: "Specialized proposal",
      extends: Proposal,
      properties: [],
    })
    expect(() =>
      defineShare("inherited-action", {
        target: SpecializedProposal,
        grants: ({ target }) => [can.view(target), can.apply(approveProposal).on(target as never)],
      })
    ).toThrow("Shared Actions are exact-type only in V1")
    expect("on" in can.apply(GlobalRefresh)).toBe(false)
  })

  test("rejects reference-bearing shared Action params recursively", () => {
    const nestedFileAction = defineAction("nested-file")
      .on(Proposal)
      .params({
        payload: param({
          type: "object",
          properties: {
            attachments: {
              schema: {
                type: "array",
                items: { type: "map", keySchema: "string", valueSchema: "fileRef" },
              },
            },
          },
        }),
      })
      .writeback(async () => {})
    const nestedObjectRefAction = defineAction("nested-object-ref")
      .on(Proposal)
      .params({
        payload: param({
          type: "object",
          properties: {
            // `objectRef` is currently only legal at the top level. Forge the runtime AST to prove
            // Share validation remains fail-closed if that type constraint is bypassed.
            customer: { schema: ref(Customer) },
          },
        } as never),
      })
      .writeback(async () => {})

    const nestedFileShare = defineShare("share-nested-file", {
      target: Proposal,
      grants: ({ target }) => [can.view(target), can.apply(nestedFileAction).on(target)],
    })
    expect(() =>
      compileShareAccessPlan({
        share: nestedFileShare,
        target: objectRef(Proposal, "proposal-1"),
        ...runtimeFor(undefined, [nestedFileAction]),
      })
    ).toThrow("Shared Action parameters cannot contain objectRef or fileRef in V1")

    const nestedObjectRefShare = defineShare("share-nested-object-ref", {
      target: Proposal,
      grants: ({ target }) => [can.view(target), can.apply(nestedObjectRefAction).on(target)],
    })
    expect(() =>
      compileShareAccessPlan({
        share: nestedObjectRefShare,
        target: objectRef(Proposal, "proposal-1"),
        ...runtimeFor(undefined, [nestedObjectRefAction]),
      })
    ).toThrow("Shared Action parameters cannot contain objectRef or fileRef in V1")
  })

  test("follows ValueType refs with a cycle guard when validating shared Action params", () => {
    const RecursivePayload: ValueType = defineValueType({
      id: "recursive-payload",
      name: "Recursive payload",
      schema: "string",
    })
    RecursivePayload.schema = {
      type: "object",
      properties: {
        self: { schema: valueTypeRef(RecursivePayload.id) },
        attachment: { schema: "fileRef" },
      },
    }
    const action = defineAction("recursive-payload-action")
      .on(Proposal)
      .params({ payload: param(valueTypeRef(RecursivePayload)) })
      .writeback(async () => {})
    const share = defineShare("recursive-payload-share", {
      target: Proposal,
      grants: ({ target }) => [can.view(target), can.apply(action).on(target)],
    })
    const runtime = runtimeFor(
      [
        {
          id: "share-test-ontology",
          version: "1",
          objectTypes: [Customer, Product, LineItem, Proposal],
          valueTypes: [RecursivePayload],
        },
      ],
      [action]
    )

    expect(() => validateSharesAtStartup({ shares: [share], ...runtime })).toThrow(
      "parameter 'payload<recursive-payload>.attachment' uses fileRef"
    )
  })

  test("cannot hide a forbidden param behind a second inline resolution of a recursive ValueType", () => {
    const resolved = {
      type: "object",
      properties: {} as Record<string, { schema: unknown }>,
    }
    resolved.properties.self = {
      schema: {
        type: "valueTypeRef",
        valueTypeId: "forged-recursive-payload",
        _resolved: "fileRef",
      },
    }
    const action = defineAction("forged-recursive-action")
      .on(Proposal)
      .params({
        payload: param({
          type: "valueTypeRef",
          valueTypeId: "forged-recursive-payload",
          _resolved: resolved,
        } as never),
      })
      .writeback(async () => {})
    const share = defineShare("forged-recursive-share", {
      target: Proposal,
      grants: ({ target }) => [can.view(target), can.apply(action).on(target)],
    })

    expect(() =>
      compileShareAccessPlan({
        share,
        target: objectRef(Proposal, "proposal-1"),
        ...runtimeFor(undefined, [action]),
      })
    ).toThrow("Shared Action parameters cannot contain objectRef or fileRef in V1")
  })

  test("reports malformed discovered grants as nominal Share errors", () => {
    const malformed = {
      kind: "share",
      id: "malformed",
      target: { kind: "object", objectTypeId: Proposal.id },
      grants: [null],
    }

    expect(() =>
      validateSharesAtStartup({ shares: [malformed as never], ...runtimeFor() })
    ).toThrow(ShareDefinitionError)
    expect(() =>
      validateSharesAtStartup({ shares: [malformed as never], ...runtimeFor() })
    ).toThrow("grant 0 must come from 'can'")
  })

  test("reports an unregistered target as a contextual Share error", () => {
    const unregistered = defineObjectType({
      id: "unregistered-share-target",
      name: "Unregistered Share target",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const share = defineShare("unregistered-target", {
      target: unregistered,
      grants: ({ target }) => [can.view(target)],
    })

    expect(() => validateSharesAtStartup({ shares: [share], ...runtimeFor() })).toThrow(
      ShareDefinitionError
    )
    expect(() => validateSharesAtStartup({ shares: [share], ...runtimeFor() })).toThrow(
      "Share 'unregistered-target' targets unknown object type 'unregistered-share-target'"
    )
  })

  test("validates duplicate ids and role references against the registered Share universe", () => {
    const runtime = runtimeFor()
    expect(() =>
      validateSharesAtStartup({ shares: [ProposalShare, ProposalShare], ...runtime })
    ).toThrow("Duplicate Share id: proposal")

    const managers = defineGroup("share-managers")
    const role = defineRole("proposal-sharer", {
      grantedTo: [managers],
      grants: [can.share(ProposalShare)],
    })
    const security = new SecurityRegistry({
      groups: [managers],
      roles: [role],
      shareIds: new Set([ProposalShare.id]),
    })
    expect(security.listResolvedRoles()[0]?.grants["share:share"]).toEqual(new Set(["proposal"]))
  })
})

describe("Share authority intersection", () => {
  const ProductV2 = defineObjectType({
    id: "product",
    name: "Product",
    properties: [prop("id", "string", { required: true, primary: true })],
  })
  const LineItemV2 = defineObjectType({
    id: "line-item",
    name: "Line item",
    properties: [prop("id", "string", { required: true, primary: true })],
    links: [link("product", ProductV2)],
  })
  const ProposalV2 = defineObjectType({
    id: "proposal",
    name: "Proposal",
    properties: [prop("id", "string", { required: true, primary: true })],
    links: [link("items", LineItemV2, { cardinality: "many" })],
  })
  const narrowedShare = defineShare("proposal", {
    target: ProposalV2,
    grants: ({ target }) => [can.view(target).withLinks([ProposalV2.l.items])],
  })

  test("removals narrow properties, links, link properties, and Actions", () => {
    const issued = compileShareAccessPlan({
      share: ProposalShare,
      target: objectRef(Proposal, "proposal-1"),
      ...runtimeFor(),
    })
    const narrowedRuntime = runtimeFor([ProductV2, LineItemV2, ProposalV2], [])
    const current = compileShareAccessPlan({
      share: narrowedShare,
      target: objectRef(ProposalV2, "proposal-1"),
      ...narrowedRuntime,
    })
    const effective = intersectShareAccessPlans(issued, current)
    expect(effective.grants.some((grant) => grant.kind === "action.apply")).toBe(false)
    const root = viewGrant(effective).selection.roots[0]
    expect(root?.node.objects).toEqual([{ objectTypeId: "proposal", propertyIds: ["id"] }])
    expect(root?.node.links).toHaveLength(1)
    expect(root?.node.links[0]?.definitions[0]).toEqual({
      sourceObjectTypeId: "proposal",
      linkId: "items",
      targetObjectTypeIds: ["line-item"],
      propertyIds: [],
    })
    expect(root?.node.links[0]?.target.links).toEqual([])
  })

  test("additions to the current definition never widen an older snapshot", () => {
    const narrowRuntime = runtimeFor([ProductV2, LineItemV2, ProposalV2], [])
    const issued = compileShareAccessPlan({
      share: narrowedShare,
      target: objectRef(ProposalV2, "proposal-1"),
      ...narrowRuntime,
    })
    const broad = compileShareAccessPlan({
      share: ProposalShare,
      target: objectRef(Proposal, "proposal-1"),
      ...runtimeFor(),
    })
    expect(intersectShareAccessPlans(issued, broad)).toEqual(issued)
  })
})

test("Share definition errors are nominal", () => {
  expect(() =>
    defineShare("", { target: Proposal, grants: ({ target }) => [can.view(target)] })
  ).toThrow(ShareDefinitionError)
})
