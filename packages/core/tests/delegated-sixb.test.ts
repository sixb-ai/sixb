import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  type ActionDefinition,
  AuthorizationError,
  defineAction,
  defineObjectType,
  link,
  type OntologySource,
  optional,
  param,
  prop,
  SixbHost,
} from "../src"
import type { RuntimeAccessPlan } from "../src/authorization/access-plan"
import { createDelegatedRequestScope } from "../src/execution/scopes"
import { ActionRunError, type SelectedObjectReadScope } from "../src/storage"
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
  .params({ note: optional(param("string")) })
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
  requestAction(input: {
    id: string
    actionId: string
    params?: Record<string, unknown>
    runId?: string
  }): Promise<unknown>
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
    ).rejects.toThrow("cannot reuse this Action run")
  })

  test("owns Action runs by Share grant across session rotation", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Proposal).upsert({
      properties: { id: "proposal-1", title: "One", status: "shared", secret: "one" },
    })

    const access: RuntimeAccessPlan = {
      grants: [
        { kind: "object.view", selection: proposalSelection(["proposal-1"]) },
        {
          kind: "action.apply",
          actionId: approveProposal.id,
          subjects: [{ objectTypeId: Proposal.id, primaryId: "proposal-1" }],
        },
      ],
    }
    await seedShareAuthority(host, {
      grantId: "grant-owner",
      sessionIds: ["session-original", "session-rotated", "session-budgeted"],
      access,
    })
    await seedShareAuthority(host, {
      grantId: "grant-other",
      sessionIds: ["session-other"],
      access,
    })

    const original = host.withScope(
      delegatedScope(host.id, access, {
        grantId: "grant-owner",
        sessionId: "session-original",
      })
    )
    const rotated = host.withScope(
      delegatedScope(host.id, access, {
        grantId: "grant-owner",
        sessionId: "session-rotated",
      })
    )
    const other = host.withScope(
      delegatedScope(host.id, access, {
        grantId: "grant-other",
        sessionId: "session-other",
      })
    )
    const originalProposals = original.objects(Proposal) as unknown as TestProposalSet
    const rotatedProposals = rotated.objects(Proposal) as unknown as TestProposalSet
    const otherProposals = other.objects(Proposal) as unknown as TestProposalSet

    const first = await originalProposals.requestAction({
      id: "proposal-1",
      actionId: approveProposal.id,
      params: { note: "stable payload" },
      runId: "grant-owned-run",
    })
    expect(first).toMatchObject({ created: true, runId: "grant-owned-run" })

    const run = await host.storage.actionRuns?.getById({
      projectId: host.id,
      id: "grant-owned-run",
    })
    expect(run).not.toBeNull()
    if (!run) throw new Error("Expected the Share-owned Action run to be stored.")
    const actionExecution = await host.storage.executions.getById({
      projectId: host.id,
      id: run.executionId,
    })
    expect(actionExecution?.source.type).toBe("execution")
    const requestExecution =
      actionExecution?.source.type === "execution"
        ? await host.storage.executions.getById({
            projectId: host.id,
            id: actionExecution.source.executionId,
          })
        : null
    expect(requestExecution).toMatchObject({
      authorizationRef: {
        type: "delegated",
        delegation: {
          kind: "share",
          grantId: "grant-owner",
          sessionId: "session-original",
        },
      },
    })
    expect(requestExecution).not.toHaveProperty("requestedBy")

    expect(await rotated.actions.runs.getById("grant-owned-run")).toEqual(run)
    const budgeted = host.withScope(
      createDelegatedRequestScope({
        projectId: host.id,
        requestId: "shared-request-session-budgeted",
        correlationId: "shared-correlation-session-budgeted",
        access,
        limits: {
          maxTraversalFacts: 100,
          maxMaterializedObjects: 100,
          maxTelemetrySeries: 10,
          maxTelemetryPoints: 100,
          maxVisibleJsonBytes: 64,
        },
        delegation: {
          kind: "share",
          id: "grant-owner",
          sessionId: "session-budgeted",
        },
      })
    )
    await expect(budgeted.actions.runs.getById("grant-owned-run")).rejects.toMatchObject({
      code: "delegated_execution_limit_exceeded",
      metric: "visibleJsonBytes",
      limit: 64,
    })
    await expect(
      rotatedProposals.requestAction({
        id: "proposal-1",
        actionId: approveProposal.id,
        params: { note: "stable payload" },
        runId: "grant-owned-run",
      })
    ).resolves.toMatchObject({ created: false, runId: "grant-owned-run" })

    expect(await other.actions.runs.getById("grant-owned-run")).toBeNull()
    await expect(
      otherProposals.requestAction({
        id: "proposal-1",
        actionId: approveProposal.id,
        params: { note: "different payload" },
        runId: "grant-owned-run",
      })
    ).rejects.toMatchObject({
      name: "AuthorizationError",
      message: expect.stringContaining("cannot reuse this Action run"),
    })

    // A same-owner payload mismatch reaches the idempotency check. This distinguishes the other
    // grant rejection above and proves ownership is checked before payload comparison.
    await expect(
      rotatedProposals.requestAction({
        id: "proposal-1",
        actionId: approveProposal.id,
        params: { note: "different payload" },
        runId: "grant-owned-run",
      })
    ).rejects.toBeInstanceOf(ActionRunError)

    for (const delegated of [original, rotated, other]) {
      await expect(delegated.actions.runs.list()).resolves.toEqual({
        runs: [],
        hasMore: false,
        total: 0,
      })
    }
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

function delegatedScope(
  projectId: string,
  access: RuntimeAccessPlan,
  delegation: { readonly grantId: string; readonly sessionId: string } = {
    grantId: "share-grant",
    sessionId: "share-session",
  }
) {
  return createDelegatedRequestScope({
    projectId,
    requestId: `shared-request-${delegation.sessionId}`,
    correlationId: `shared-correlation-${delegation.sessionId}`,
    access,
    delegation: {
      kind: "share",
      id: delegation.grantId,
      sessionId: delegation.sessionId,
    },
  })
}

async function seedShareAuthority(
  host: ReturnType<typeof createRuntime>,
  input: {
    readonly grantId: string
    readonly sessionIds: readonly string[]
    readonly access: RuntimeAccessPlan
  }
): Promise<void> {
  const createdAt = new Date("2026-01-01T00:00:00.000Z")
  const expiresAt = new Date("2099-01-01T00:00:00.000Z")
  const grants = host.storage.shareGrants
  const sessions = host.storage.shareSessions
  if (!grants || !sessions) throw new Error("Test runtime requires Share grant/session storage.")
  await grants.create({
    id: input.grantId,
    projectId: host.id,
    definitionId: "proposal-test-share",
    target: { objectTypeId: Proposal.id, primaryId: "proposal-1" },
    issuedBy: { type: "user", id: `issuer-${input.grantId}` },
    authoritySnapshot: { version: 1, access: input.access },
    tokenHash: sha256(`grant:${input.grantId}`),
    destinationPath: "/proposals/proposal-1",
    createdAt,
    expiresAt,
  })
  for (const sessionId of input.sessionIds) {
    await sessions.create({
      id: sessionId,
      projectId: host.id,
      grantId: input.grantId,
      tokenHash: sha256(`session:${sessionId}`),
      createdAt,
      expiresAt: new Date("2098-01-01T00:00:00.000Z"),
      absoluteExpiresAt: expiresAt,
    })
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
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
