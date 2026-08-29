import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
  AuthorizationError,
  defineAction,
  defineObjectType,
  link,
  type OntologySource,
  prop,
  SixbHost,
} from "../src"
import type { RuntimeAccessPlan } from "../src/authorization/access-plan"
import { createDelegatedRequestScope } from "../src/execution/scopes"
import type { SelectedObjectReadScope } from "../src/storage"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const LineItem = defineObjectType({
  id: "LineItem",
  name: "Line item",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string"),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
})

const Proposal = defineObjectType({
  id: "Proposal",
  name: "Proposal",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string"),
    prop("status", "string", { query: { searchable: true, facet: true } }),
    prop("secret", "string", { query: { searchable: true, facet: true } }),
  ],
  links: [link("items", LineItem), link("reviewers", LineItem)],
})

const ArchivedProposal = defineObjectType({
  id: "ArchivedProposal",
  name: "Archived proposal",
  extends: Proposal,
  properties: [prop("archived", "boolean")],
})

const approveProposal: ActionDefinition = defineAction("approve-proposal")
  .on(Proposal)
  .params({})
  .edits(() => {})

const rejectProposal: ActionDefinition = defineAction("reject-proposal")
  .on(Proposal)
  .params({})
  .edits(() => {})

interface TestProposalQuery {
  list(): Promise<{ objects: readonly { primaryId: string }[] }>
  count(): Promise<number>
  facets(
    input: readonly { property: { readonly id: string }; limit: number }[]
  ): Promise<readonly { propertyId: string; buckets: readonly unknown[] }[]>
  traverse(link: unknown): TestProposalQuery
}

interface TestProposalSet {
  get(id: string): Promise<{ primaryId: string } | null>
  list(input?: {
    limit?: number
    offset?: number
  }): Promise<{ objects: readonly { primaryId: string }[] }>
  query(): TestProposalQuery
  byId(id: string): {
    listLinks(link?: unknown): Promise<readonly unknown[]>
  }
  requestAction(input: { id: string; actionId: string; runId?: string }): Promise<unknown>
}

interface TestObjectRuntime {
  list(input: {
    objectTypeIds: readonly string[]
    limit?: number
    offset?: number
  }): Promise<{ objects: readonly { objectTypeId: string; primaryId: string }[] }>
  executeQuery(input: {
    query: { kind: "start"; objectTypeId: string; includeSubtypes: true }
  }): Promise<{ objects: readonly { objectTypeId: string; primaryId: string }[] }>
  getTelemetryHistory(input: {
    objectTypeId: string
    objectId: string
    propertyId: string
    limit?: number
  }): Promise<readonly unknown[]>
  getLatestTelemetry(input: {
    objectTypeId: string
    objectId: string
    propertyId: string
  }): Promise<unknown>
}

interface TestLineItemSet {
  byId(id: string): {
    telemetry(property: unknown): {
      history(input?: { limit?: number }): Promise<readonly { value: unknown }[]>
    }
  }
}

function createRuntime() {
  return new SixbHost<readonly OntologySource[]>({
    id: "delegated-sixb-test",
    ontology: [Proposal, ArchivedProposal, LineItem],
    actions: [approveProposal, rejectProposal],
    ...createTestRuntimeDeps(),
  })
}

describe("delegated Sixb runtime", () => {
  test("enforces exact reads through the canonical Sixb APIs", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Proposal).upsert({
      properties: {
        id: "proposal-1",
        title: "Shared",
        status: "shared",
        secret: "visible only outside the delegation",
      },
    })
    await sixb.objects(ArchivedProposal).upsert({
      properties: {
        id: "proposal-added-subtype",
        title: "Must not widen an issued selection",
        status: "private",
        secret: "private",
        archived: true,
      },
    })
    await sixb.objects(Proposal).upsert({
      properties: {
        id: "proposal-2",
        title: "Guessed sibling",
        status: "private",
        secret: "must stay private",
      },
    })
    const item = await sixb.objects(LineItem).upsert({
      properties: { id: "item-1", name: "Shared item" },
    })
    await sixb.objects(Proposal).byId("proposal-1").link(Proposal.l.items, item)
    await sixb.objects(Proposal).byId("proposal-1").link(Proposal.l.reviewers, item)

    const shared = host.withScope(
      delegatedScope(host.id, {
        grants: [{ kind: "object.view", selection: proposalSelection(["proposal-1"], true) }],
      })
    )
    // Keep this runtime security test focused on behavior. The fully recursive TwinObject return
    // type can hit TypeScript's instantiation limit when a linked type is inferred in this fixture.
    const sharedProposals = shared.objects(Proposal) as unknown as TestProposalSet

    expect(await sharedProposals.get("proposal-2")).toBeNull()
    expect((await sharedProposals.list()).objects.map((row) => row.primaryId)).toEqual([
      "proposal-1",
    ])
    expect((await sharedProposals.query().list()).objects.map((row) => row.primaryId)).toEqual([
      "proposal-1",
    ])
    expect(await sharedProposals.query().count()).toBe(1)
    const polymorphic = await (shared.objects as unknown as TestObjectRuntime).executeQuery({
      query: { kind: "start", objectTypeId: Proposal.id, includeSubtypes: true },
    })
    expect(polymorphic.objects.map((row) => [row.objectTypeId, row.primaryId])).toEqual([
      [Proposal.id, "proposal-1"],
    ])
    const crossType = await (shared.objects as unknown as TestObjectRuntime).list({
      objectTypeIds: [Proposal.id],
    })
    expect(crossType.objects.map((row) => [row.objectTypeId, row.primaryId])).toEqual([
      [Proposal.id, "proposal-1"],
    ])
    expect(
      await sharedProposals.query().facets([{ property: Proposal.p.status, limit: 10 }])
    ).toEqual([{ propertyId: "status", buckets: [{ value: "shared", count: 1 }] }])

    expect(await sharedProposals.byId("proposal-1").listLinks(Proposal.l.items)).toHaveLength(1)
    expect(await sharedProposals.byId("proposal-1").listLinks(Proposal.l.reviewers)).toEqual([])

    // Guard proof: removing the delegated-query validator call from executor.ts makes this return
    // an empty result instead of rejecting the unselected edge.
    await expect(
      sharedProposals.query().traverse(Proposal.l.reviewers).list()
    ).rejects.toBeInstanceOf(AuthorizationError)
    await expect(
      sharedProposals.query().facets([{ property: Proposal.p.secret, limit: 10 }])
    ).rejects.toBeInstanceOf(AuthorizationError)

    // Provider guard proof: bypassing the scoped object relation makes the guessed sibling appear
    // here and changes list/query/count/facet semantics before their limits are applied.
  })

  test("preserves action and exact-subject pairs before durable dispatch", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Proposal).upsert({
      properties: { id: "proposal-1", title: "One", status: "shared", secret: "one" },
    })
    await sixb.objects(Proposal).upsert({
      properties: { id: "proposal-2", title: "Two", status: "shared", secret: "two" },
    })

    const shared = host.withScope(
      delegatedScope(host.id, {
        grants: [
          { kind: "object.view", selection: proposalSelection(["proposal-1", "proposal-2"]) },
          {
            kind: "action.apply",
            actionId: approveProposal.id,
            subjects: [{ objectTypeId: Proposal.id, primaryId: "proposal-1" }],
          },
          {
            kind: "action.apply",
            actionId: rejectProposal.id,
            subjects: [{ objectTypeId: Proposal.id, primaryId: "proposal-2" }],
          },
        ],
      })
    )
    const sharedProposals = shared.objects(Proposal) as unknown as TestProposalSet

    expect(shared.actions.list().map((action) => action.id)).toEqual([
      approveProposal.id,
      rejectProposal.id,
    ])
    expect(shared.actions.getById(approveProposal.id)?.id).toBe(approveProposal.id)
    expect(shared.actions.listForType(Proposal).map((action) => action.id)).toEqual([
      approveProposal.id,
      rejectProposal.id,
    ])

    await expect(
      sharedProposals.requestAction({
        id: "proposal-2",
        actionId: approveProposal.id,
        runId: "cross-approve",
      })
    ).rejects.toBeInstanceOf(AuthorizationError)
    await expect(
      sharedProposals.requestAction({
        id: "proposal-1",
        actionId: rejectProposal.id,
        runId: "cross-reject",
      })
    ).rejects.toBeInstanceOf(AuthorizationError)

    expect(
      await host.storage.actionRuns?.getById({
        projectId: host.id,
        id: "cross-approve",
      })
    ).toBeNull()
    expect(
      await host.storage.actionRuns?.getById({
        projectId: host.id,
        id: "cross-reject",
      })
    ).toBeNull()

    await sixb.objects(Proposal).requestAction({
      id: "proposal-1",
      actionId: approveProposal.id,
      runId: "preexisting-run",
    })

    // Guard proof: moving the durable-authority check back into createExecution makes this reuse
    // the unrestricted run before delegated authority is rejected.
    await expect(
      sharedProposals.requestAction({
        id: "proposal-1",
        actionId: approveProposal.id,
        runId: "preexisting-run",
      })
    ).rejects.toThrow("cannot cross a durable execution boundary yet")

    // M01 deliberately cannot serialize delegated authority yet. A valid pair reaches that
    // fail-closed boundary; the shared-session milestone replaces this temporary assertion.
    await expect(
      sharedProposals.requestAction({
        id: "proposal-1",
        actionId: approveProposal.id,
        runId: "allowed-before-durable-boundary",
      })
    ).rejects.toThrow("cannot cross a durable execution boundary yet")
  })

  test("validates and budgets object list windows before storage", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Proposal).upsert({
      properties: { id: "proposal-1", title: "One", status: "shared" },
    })
    await sixb.objects(Proposal).upsert({
      properties: { id: "proposal-2", title: "Two", status: "shared" },
    })

    const shared = host.withScope(
      createDelegatedRequestScope({
        projectId: host.id,
        requestId: "shared-list-budget",
        correlationId: "shared-list-budget",
        access: {
          grants: [
            {
              kind: "object.view",
              selection: proposalSelection(["proposal-1", "proposal-2"]),
            },
          ],
        },
        limits: {
          maxTraversalFacts: 100,
          maxMaterializedObjects: 1,
          maxTelemetrySeries: 100,
          maxTelemetryPoints: 10_000,
          maxVisibleJsonBytes: 1024,
        },
        delegation: { kind: "share", id: "share-grant", sessionId: "share-session" },
      })
    )
    const sharedProposals = shared.objects(Proposal) as unknown as TestProposalSet
    const sharedObjects = shared.objects as unknown as TestObjectRuntime

    await expect(sharedProposals.list({ limit: 2 })).rejects.toMatchObject({
      code: "delegated_execution_limit_exceeded",
      metric: "materializedObjects",
      limit: 1,
    })
    await expect(sharedProposals.list({ limit: -1 })).rejects.toThrow(
      "Object list limit must be a non-negative safe integer"
    )
    await expect(
      sharedObjects.list({ objectTypeIds: [Proposal.id], offset: Number.POSITIVE_INFINITY })
    ).rejects.toThrow("Object list offset must be a non-negative safe integer")
  })

  test("does not inherit parent actions onto delegated subtype subjects", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(ArchivedProposal).upsert({
      properties: {
        id: "archived-1",
        title: "Archived",
        status: "shared",
        archived: true,
      },
    })

    const shared = host.withScope(
      delegatedScope(host.id, {
        grants: [
          {
            kind: "object.view",
            selection: {
              kind: "selected",
              roots: [
                {
                  anchor: { objectTypeId: ArchivedProposal.id, primaryId: "archived-1" },
                  node: {
                    objects: [
                      {
                        objectTypeId: ArchivedProposal.id,
                        propertyIds: ["id", "title", "status", "archived"],
                      },
                    ],
                    links: [],
                  },
                },
              ],
            },
          },
          {
            kind: "action.apply",
            actionId: approveProposal.id,
            subjects: [{ objectTypeId: ArchivedProposal.id, primaryId: "archived-1" }],
          },
        ],
      })
    )

    expect(shared.actions.list()).toEqual([])
    expect(shared.actions.getById(approveProposal.id)).toBeNull()
    expect(shared.actions.listForType(ArchivedProposal)).toEqual([])
    expect(shared.actions.listForType(Proposal)).toEqual([])

    await expect(
      shared.actions.request({
        actionId: approveProposal.id,
        subject: {
          kind: "object",
          objectTypeId: ArchivedProposal.id,
          primaryId: "archived-1",
        },
        runId: "delegated-inherited-action",
      })
    ).rejects.toBeInstanceOf(AuthorizationError)
    expect(
      await host.storage.actionRuns?.getById({
        projectId: host.id,
        id: "delegated-inherited-action",
      })
    ).toBeNull()
  })

  test("binds telemetry properties to the exact selected object provenance", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Proposal).upsert({
      properties: { id: "proposal-1", title: "One", status: "shared", secret: "one" },
    })
    const item = await sixb.objects(LineItem).upsert({
      properties: { id: "item-1", name: "Item" },
    })
    const reviewer = await sixb.objects(LineItem).upsert({
      properties: { id: "reviewer-1", name: "Reviewer" },
    })
    await sixb.objects(Proposal).byId("proposal-1").link(Proposal.l.items, item)
    await sixb.objects(Proposal).byId("proposal-1").link(Proposal.l.reviewers, reviewer)
    await sixb.objects(LineItem).appendTelemetryBatch([
      {
        id: "item-1",
        properties: { temperature: 21 },
        at: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: "reviewer-1",
        properties: { temperature: 99 },
        at: new Date("2026-01-01T00:00:00.000Z"),
      },
    ])

    const shared = host.withScope(
      delegatedScope(host.id, {
        grants: [{ kind: "object.view", selection: telemetrySelection() }],
      })
    )
    const sharedItems = shared.objects(LineItem) as unknown as TestLineItemSet

    expect(
      await sharedItems.byId("item-1").telemetry(LineItem.p.temperature).history({ limit: 1 })
    ).toMatchObject([{ value: 21 }])
    // Both LineItems are visible. Only the `items` provenance selected temperature, so a global
    // type+property check would leak the reviewer's series here.
    expect(
      await sharedItems.byId("reviewer-1").telemetry(LineItem.p.temperature).history({ limit: 1 })
    ).toEqual([])

    const tinyOutput = host.withScope(
      createDelegatedRequestScope({
        projectId: host.id,
        requestId: "shared-tiny-output",
        correlationId: "shared-tiny-output",
        access: { grants: [{ kind: "object.view", selection: telemetrySelection() }] },
        limits: {
          maxTraversalFacts: 100,
          maxMaterializedObjects: 100,
          maxTelemetrySeries: 100,
          maxTelemetryPoints: 10_000,
          maxVisibleJsonBytes: 8,
        },
        delegation: { kind: "share", id: "share-grant", sessionId: "share-session" },
      })
    )
    const tinyOutputObjects = tinyOutput.objects as unknown as TestObjectRuntime
    const series = {
      objectTypeId: LineItem.id,
      objectId: "item-1",
      propertyId: LineItem.p.temperature.id,
    }
    await expect(
      tinyOutputObjects.getTelemetryHistory({ ...series, limit: 1 })
    ).rejects.toMatchObject({
      code: "delegated_execution_limit_exceeded",
      metric: "visibleJsonBytes",
      limit: 8,
    })
    await expect(tinyOutputObjects.getLatestTelemetry(series)).rejects.toMatchObject({
      code: "delegated_execution_limit_exceeded",
      metric: "visibleJsonBytes",
      limit: 8,
    })
  })
})

function delegatedScope(projectId: string, access: RuntimeAccessPlan) {
  return createDelegatedRequestScope({
    projectId,
    requestId: "shared-request",
    correlationId: "shared-correlation",
    access,
    delegation: { kind: "share", id: "share-grant", sessionId: "share-session" },
  })
}

function proposalSelection(
  primaryIds: readonly string[],
  includeItems = false
): SelectedObjectReadScope {
  return {
    kind: "selected",
    roots: primaryIds.map((primaryId) => ({
      anchor: { objectTypeId: Proposal.id, primaryId },
      node: {
        objects: [{ objectTypeId: Proposal.id, propertyIds: ["id", "title", "status"] }],
        links: includeItems
          ? [
              {
                definitions: [
                  {
                    sourceObjectTypeId: Proposal.id,
                    linkId: Proposal.l.items.id,
                    targetObjectTypeIds: [LineItem.id],
                    propertyIds: [],
                  },
                ],
                target: {
                  objects: [{ objectTypeId: LineItem.id, propertyIds: ["id", "name"] }],
                  links: [],
                },
              },
            ]
          : [],
      },
    })),
  }
}

function telemetrySelection(): SelectedObjectReadScope {
  return {
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
                  linkId: Proposal.l.items.id,
                  targetObjectTypeIds: [LineItem.id],
                  propertyIds: [],
                },
              ],
              target: {
                objects: [{ objectTypeId: LineItem.id, propertyIds: ["id", "temperature"] }],
                links: [],
              },
            },
            {
              definitions: [
                {
                  sourceObjectTypeId: Proposal.id,
                  linkId: Proposal.l.reviewers.id,
                  targetObjectTypeIds: [LineItem.id],
                  propertyIds: [],
                },
              ],
              target: {
                objects: [{ objectTypeId: LineItem.id, propertyIds: ["id"] }],
                links: [],
              },
            },
          ],
        },
      },
    ],
  }
}
