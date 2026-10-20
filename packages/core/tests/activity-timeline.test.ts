import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import {
  can,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  project,
  prop,
  resolveAuthorizationContext,
  SixbHost,
} from "../src"
import { describeUserAgent } from "../src/activity/device"
import type { ActivityTimelineEntry } from "../src/activity/timeline"
import type { AiCostSummary, CreateExecutionInput, ExecutionRecord, Storage } from "../src/storage"
import { createTestAgentExecution, createTestSixb } from "../src/testing"
import {
  Customer,
  createAppliedProject,
  Invoice as MarkedInvoice,
} from "./applied-markings-fixture"

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
})
const Payroll = defineObjectType({
  id: "Payroll",
  name: "Payroll",
  properties: [prop("id", "string", { required: true, primary: true })],
})
const markPaid = defineAction("markPaid")
  .on(Invoice)
  .params({})
  .writeback(() => ({}))
const observers = defineGroup("observers")
const observer = defineRole("observer", {
  grantedTo: [observers],
  grants: [can.observe(project.activity), can.view(Invoice), can.apply(markPaid)],
})

const projectId = "activity-timeline"
const start = new Date("2026-10-20T14:02:00.000Z")
const second = 1_000
const minute = 60_000
const chrome =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"

afterEach(() => {
  setSystemTime()
})

async function createFixture() {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [Invoice, Payroll],
    actions: [markPaid],
    groups: [observers],
    roles: [observer],
    storage,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    auth: { id: "test", kind: "dev" },
    activity: { enabled: true },
  })

  for (const userId of ["marie", "other"]) {
    await storage.auth.users.create({ projectId, id: userId, email: `${userId}@example.test` })
    await storage.auth.sessions.create({
      projectId,
      id: `ses_${userId}`,
      userId,
      strategyId: "test",
      tokenHash: `hash-${userId}`,
      createdAt: new Date(start.getTime() - 60 * minute),
      expiresAt: new Date(start.getTime() + 48 * 60 * minute),
      userAgent: chrome,
      ipAddress: "203.0.113.7",
    })
  }

  const viewer = createTestSixb(host, {
    authorization: resolveAuthorizationContext({
      principal: { type: "user", id: "viewer" },
      groupIds: [observers.id],
      roles: host.definitions.security.listResolvedRoles(),
    }),
  })
  const stranger = createTestSixb(host, {
    authorization: resolveAuthorizationContext({
      principal: { type: "user", id: "stranger" },
      groupIds: [],
      roles: host.definitions.security.listResolvedRoles(),
    }),
  })

  return { host, storage, viewer, stranger }
}

/** Creates an execution at `offsetMs` after the first visit's start: storage stamps it. */
async function executionAt(storage: Storage, offsetMs: number, input: CreateExecutionInput) {
  setSystemTime(new Date(start.getTime() + offsetMs))
  try {
    return await storage.executions.create(input)
  } finally {
    setSystemTime()
  }
}

function request(id: string, userId = "marie", sessionId = `ses_${userId}`): CreateExecutionInput {
  return {
    id,
    projectId,
    requestedBy: { type: "user", id: userId },
    executor: { type: "request", requestId: id },
    source: { type: "http", requestId: id },
    correlationId: `correlation-${id}`,
    authorizationRef: {
      type: "principal",
      principal: { type: "user", id: userId },
      credential: { type: "session", id: sessionId },
    },
  }
}

function primitive(
  parent: ExecutionRecord,
  kind: "action" | "workflow",
  primitiveId: string,
  runId: string
): CreateExecutionInput {
  return {
    id: `execution_${runId}`,
    projectId: parent.projectId,
    ...(parent.requestedBy === undefined ? {} : { requestedBy: parent.requestedBy }),
    executor: { type: "primitive", kind, runId },
    source: { type: "execution", executionId: parent.id },
    correlationId: parent.correlationId,
    authorizationRef: { type: "trustedPrimitive", primitive: { kind, id: primitiveId, runId } },
  }
}

async function recordAction(
  storage: Storage,
  execution: ExecutionRecord,
  subject: { readonly objectTypeId: string; readonly primaryId: string }
) {
  if (
    execution.executor.type !== "primitive" ||
    execution.authorizationRef.type !== "trustedPrimitive"
  ) {
    throw new Error("Expected an action execution")
  }

  await storage.actionRuns?.record({
    id: execution.executor.runId,
    projectId: execution.projectId,
    executionId: execution.id,
    actionId: execution.authorizationRef.primitive.id,
    subject: { kind: "object", ...subject },
    phase: "commit",
    status: "succeeded",
    startedAt: execution.createdAt,
    finishedAt: execution.createdAt,
    params: {},
    idempotencyKey: execution.executor.runId,
  })
}

/**
 * Page views of one session, each `offsetsMs` after the first visit's start, in batches of up to
 * twenty at one instant. Returns the session's visits, oldest first.
 */
async function pageViews(
  storage: Storage,
  input: {
    readonly offsetsMs: readonly (number | readonly [number, number])[]
    readonly sessionId?: string
    readonly projectId?: string
  }
): Promise<readonly string[]> {
  const sessionId = input.sessionId ?? "ses_marie"
  const project = input.projectId ?? projectId

  for (const [index, entry] of input.offsetsMs.entries()) {
    const [offset, count] = typeof entry === "number" ? [entry, 1] : entry
    const result = await storage.activity?.append({
      projectId: project,
      actor: { type: "user", userId: "marie" },
      sessionId,
      events: Array.from({ length: count }, (_, event) => ({
        id: `${sessionId}-${offset}-${index}-${event}`,
        type: "page.view" as const,
        route: `/page/${offset}`,
      })),
      now: new Date(start.getTime() + offset),
      idleTimeoutMs: 30 * minute,
      newVisitId: `visit_${String(offset).padStart(12, "0")}`,
    })
    if (result?.status !== "accepted") {
      throw new Error("Expected the page views to be accepted")
    }
  }

  const sessions = await storage.activity?.sessionVisits({
    projectId: project,
    userId: "marie",
    sessionIds: [sessionId],
    limit: 100,
  })
  return (sessions?.[0]?.latest ?? []).map((visit) => visit.id).reverse()
}

/** Entries without what varies between runs: their time and execution id. */
function stable(entries: readonly ActivityTimelineEntry[] | undefined) {
  return entries?.map((entry) => {
    if (entry.kind === "page") {
      const { at: _at, ...page } = entry
      return page
    }
    const { at: _at, executionId: _executionId, ...rest } = entry
    return rest
  })
}

function runIds(entries: readonly ActivityTimelineEntry[] | undefined) {
  return entries?.flatMap((entry) => (entry.kind === "page" ? [] : [entry.runId]))
}

function cost(amountNanos: string, ratedCallCount = 1): AiCostSummary {
  return {
    amounts: ratedCallCount === 0 ? [] : [{ currency: "USD", amountNanos }],
    ratedCallCount,
    unpriceableCallCount: 0,
    unvaluedCallCount: 0,
  }
}

function stubCosts(storage: Storage, costs: Readonly<Record<string, AiCostSummary>>) {
  Object.defineProperty(storage, "aiCosts", {
    value: {
      ...storage.aiCosts,
      summarizeExecutions: async (input: { readonly executionIds: readonly string[] }) =>
        input.executionIds.map((id) => costs[id] ?? cost("0", 0)),
    },
  })
}

describe("activity timeline", () => {
  // Guard proof: link every recorded subject in composeActivityTimeline; the Payroll object, whose
  // type the viewer cannot see, is linked too.
  test("a visit shows what its session started, linking only the objects the viewer reads", async () => {
    const { host, storage, viewer, stranger } = await createFixture()
    const [visitId] = await pageViews(storage, { offsetsMs: [0, 3 * minute] })

    await createTestSixb(host)
      .objects(Invoice)
      .upsert({ properties: { id: "inv-1" } })
    await createTestSixb(host)
      .objects(Payroll)
      .upsert({ properties: { id: "pay-1" } })

    // A click right after the return reaches the server before the activity opening the visit.
    const early = await executionAt(storage, -10 * second, request("early"))
    await executionAt(storage, -9.9 * second, primitive(early, "action", "assign", "act_assign"))

    const root = await executionAt(storage, minute, request("root"))
    await recordAction(
      storage,
      await executionAt(storage, minute + 100, primitive(root, "action", "markPaid", "act_paid")),
      { objectTypeId: "Invoice", primaryId: "inv-1" }
    )
    await recordAction(
      storage,
      await executionAt(
        storage,
        minute + 200,
        primitive(root, "action", "approvePayroll", "act_payroll")
      ),
      { objectTypeId: "Payroll", primaryId: "pay-1" }
    )
    // A subject deleted since, or never written, is not linked either.
    await recordAction(
      storage,
      await executionAt(storage, minute + 250, primitive(root, "action", "markPaid", "act_gone")),
      { objectTypeId: "Invoice", primaryId: "inv-gone" }
    )
    const workflow = await executionAt(
      storage,
      minute + 300,
      primitive(root, "workflow", "remind", "wfr_remind")
    )
    await storage.workflowRuns?.queue({
      id: "wfr_remind",
      projectId,
      executionId: workflow.id,
      workflowId: "remind",
      input: {},
    })

    setSystemTime(new Date(start.getTime() + 2 * minute))
    const agentExecutionId = await createTestAgentExecution(storage, {
      projectId,
      runId: "run_chat",
      sourceExecutionId: root.id,
    })
    // A subagent of the conversation, and an Agent step of the workflow: neither is a conversation.
    const subagentExecutionId = await createTestAgentExecution(storage, {
      projectId,
      runId: "run_sub",
      sourceExecutionId: agentExecutionId,
    })
    const stepExecutionId = await createTestAgentExecution(storage, {
      projectId,
      actorId: "reminder",
      runId: "run_step",
      sourceExecutionId: workflow.id,
    })
    setSystemTime()

    await storage.agents?.threads.create({
      id: "thr_1",
      projectId,
      ownerPrincipal: { type: "user", id: "marie" },
      title: "Overdue invoices",
    })
    await storage.agents?.messages.append({
      id: "msg_1",
      projectId,
      threadId: "thr_1",
      runId: null,
      role: "user",
      parts: [{ type: "text", text: "Which invoices are late?" }],
    })
    await storage.agents?.runs.create({
      id: "run_chat",
      projectId,
      executionId: agentExecutionId,
      threadId: "thr_1",
      triggerMessageId: "msg_1",
      spec: { model: { provider: "test", modelId: "large" } },
    })
    await storage.agents?.runs.start({
      id: "run_chat",
      projectId,
      execution: { token: "delivery-1", queueLeaseExpiresAt: new Date(Date.now() + minute) },
    })
    await storage.agents?.runs.createSubagent({
      id: "run_sub",
      projectId,
      executionId: subagentExecutionId,
      parentRunId: "run_chat",
      parentExecutionToken: "delivery-1",
      spawnKey: "research",
      spec: {
        model: { provider: "test", modelId: "small" },
        task: "Find the late invoices.",
        toolNames: [],
        maxSteps: 5,
      },
      maxActiveChildren: 4,
    })

    const agentExecution = await storage.executions.getById({ projectId, id: agentExecutionId })
    if (!agentExecution) {
      throw new Error("Expected the Agent execution")
    }
    const tool = await executionAt(
      storage,
      2 * minute + 100,
      primitive(agentExecution, "action", "markPaid", "act_tool")
    )

    // Descendants count whenever they run: this one long after the visit.
    await executionAt(
      storage,
      2 * 60 * minute,
      primitive(workflow, "action", "sendReminder", "act_late")
    )

    // Neither another visit of the session, nor another session's request.
    await executionAt(storage, -10 * minute, request("before"))
    await executionAt(storage, minute, request("elsewhere", "other"))

    // The conversation counts its own calls, its subagent's and its tool's; not the workflow's.
    stubCosts(storage, {
      [agentExecutionId]: cost("30000"),
      [subagentExecutionId]: cost("5000"),
      [tool.id]: cost("10000"),
      [stepExecutionId]: cost("70000"),
    })

    const timeline = await viewer.activity.timeline(visitId ?? "")

    expect(timeline?.truncated).toBe(false)
    expect(timeline?.connection).toEqual({
      type: "session",
      device: { browser: "Chrome", os: "macOS" },
      status: "active",
      createdAt: new Date(start.getTime() - 60 * minute),
    })
    expect(stable(timeline?.entries)).toEqual([
      {
        kind: "action",
        actionId: "assign",
        runId: "act_assign",
        status: "incomplete",
        runVisible: false,
      },
      { kind: "page", sequence: 1, route: "/page/0" },
      {
        kind: "action",
        actionId: "markPaid",
        runId: "act_paid",
        status: "succeeded",
        runVisible: true,
        object: { objectTypeId: "Invoice", primaryId: "inv-1" },
      },
      // The viewer may neither apply this action nor see its subject's type.
      {
        kind: "action",
        actionId: "approvePayroll",
        runId: "act_payroll",
        status: "succeeded",
        runVisible: false,
      },
      {
        kind: "action",
        actionId: "markPaid",
        runId: "act_gone",
        status: "succeeded",
        runVisible: true,
      },
      {
        kind: "workflow",
        workflowId: "remind",
        runId: "wfr_remind",
        status: "queued",
        runVisible: false,
      },
      {
        kind: "agent",
        runId: "run_chat",
        threadId: "thr_1",
        status: "running",
        messages: 1,
        cost: {
          amounts: [{ currency: "USD", amountNanos: "45000" }],
          ratedCallCount: 3,
          unpriceableCallCount: 0,
          unvaluedCallCount: 0,
        },
      },
      {
        kind: "action",
        actionId: "markPaid",
        runId: "act_tool",
        status: "incomplete",
        runVisible: false,
      },
      { kind: "page", sequence: 2, route: `/page/${3 * minute}` },
      {
        kind: "action",
        actionId: "sendReminder",
        runId: "act_late",
        status: "incomplete",
        runVisible: false,
      },
    ])
    expect(timeline?.entries.find((entry) => entry.kind === "action")).toMatchObject({
      executionId: "execution_act_assign",
    })

    // Thread content, addresses and the session itself stay out.
    const serialized = JSON.stringify(timeline)
    for (const hidden of ["Overdue invoices", "Which invoices", "203.0.113.7", "ses_marie"]) {
      expect(serialized).not.toContain(hidden)
    }

    await expect(stranger.activity.timeline(visitId ?? "")).rejects.toThrow("not allowed")
    await expect(viewer.activity.timeline("visit_missing")).resolves.toBeNull()
  })

  // Guard proof: drop the day cap from sessionWindow; the root past the second visit's cap shows in
  // the second visit as well as the third.
  test("each visit of a session claims the roots of its own window", async () => {
    const { storage, viewer } = await createFixture()
    const day = 24 * 60 * minute
    const nextStart = 40 * minute

    // Idle for 30 minutes after 3 minutes: a second visit starts at 40 minutes. Active every 20
    // minutes from then, it lasts until its day-long cap, and a third starts just past it.
    const steady = Array.from({ length: 72 }, (_, index) => nextStart + index * 20 * minute)
    const visits = await pageViews(storage, {
      offsetsMs: [
        0,
        3 * minute,
        ...steady,
        nextStart + day - 10 * second,
        nextStart + day + 5 * second,
      ],
    })
    expect(visits).toHaveLength(3)

    const withAction = async (offset: number, id: string) => {
      const root = await executionAt(storage, offset, request(id))
      await executionAt(storage, offset + 1, primitive(root, "action", "markPaid", `act_${id}`))
    }
    // 20 s after the first visit's last activity, and 20 s before the second's start.
    await withAction(3 * minute + 20 * second, "after-first")
    await withAction(nextStart - 20 * second, "before-second")
    // Past `start + 24 h - 30 s` of the second visit, active 10 s before its cap: the third's.
    await withAction(nextStart + day - 20 * second, "at-cap")

    const runsOf = async (visitId: string | undefined) =>
      runIds((await viewer.activity.timeline(visitId ?? ""))?.entries)

    expect(await runsOf(visits[0])).toEqual(["act_after-first"])
    expect(await runsOf(visits[1])).toEqual(["act_before-second"])
    expect(await runsOf(visits[2])).toEqual(["act_at-cap"])
  })

  // Guard proof: drop the page-view cutoff in composeActivityTimeline; the action after the 200th
  // page view shows.
  test("past the 200th page view the timeline stops, and says so", async () => {
    const { storage, viewer } = await createFixture()
    const [visitId] = await pageViews(storage, {
      offsetsMs: Array.from({ length: 11 }, (_, index) => [index * minute, 20] as const),
    })

    const within = await executionAt(storage, 30 * second, request("within"))
    await executionAt(storage, 31 * second, primitive(within, "action", "markPaid", "act_in"))
    const beyond = await executionAt(storage, 10 * minute + second, request("beyond"))
    await executionAt(
      storage,
      10 * minute + 2 * second,
      primitive(beyond, "action", "markPaid", "act_out")
    )

    const timeline = await viewer.activity.timeline(visitId ?? "")

    expect(timeline?.truncated).toBe(true)
    expect(timeline?.entries.filter((entry) => entry.kind === "page")).toHaveLength(200)
    expect(runIds(timeline?.entries)).toEqual(["act_in"])
  })

  // Guard proof: drop the root cutoff in composeActivityTimeline; the last page view shows though
  // the roots before it were left out.
  test("past the 200th recorded execution the timeline stops at the last root kept", async () => {
    const { storage, viewer } = await createFixture()
    const [visitId] = await pageViews(storage, { offsetsMs: [0, 9 * minute] })

    for (let index = 0; index < 205; index += 1) {
      await executionAt(storage, index * 2 * second, request(`root-${index}`))
    }

    const timeline = await viewer.activity.timeline(visitId ?? "")

    expect(timeline?.truncated).toBe(true)
    expect(stable(timeline?.entries)).toEqual([{ kind: "page", sequence: 1, route: "/page/0" }])
  })

  test("a user's connections list every sign-in with the visits it opened", async () => {
    const { host, storage, viewer, stranger } = await createFixture()
    const [visitId] = await pageViews(storage, { offsetsMs: [0] })
    await storage.auth.sessions.revoke({ projectId, id: "ses_marie", revokedAt: start })

    const native = host.auth.prepareBearerSession({
      userId: "marie",
      clientName: "sixb CLI on alex-mbp",
      now: new Date(start.getTime() + minute),
    })
    await storage.auth.sessions.create(native.session)

    const page = await viewer.activity.connections({ userId: "marie" })

    expect(page.nextCursor).toBeUndefined()
    expect(
      page.connections.map((connection) => ({
        device: connection.device,
        clientName: connection.clientName,
        status: connection.status,
        visits: connection.visits,
        latest: connection.latestVisits.map((visit) => visit.id),
      }))
    ).toEqual([
      { device: {}, clientName: "sixb CLI on alex-mbp", status: "active", visits: 0, latest: [] },
      {
        device: { browser: "Chrome", os: "macOS" },
        clientName: undefined,
        status: "revoked",
        visits: 1,
        latest: [visitId],
      },
    ])
    expect(JSON.stringify(page)).not.toContain("203.0.113.7")

    // The cursor continues the list without naming a session.
    const first = await viewer.activity.connections({ userId: "marie", limit: 1 })
    expect(first.connections.map((connection) => connection.clientName)).toEqual([
      "sixb CLI on alex-mbp",
    ])
    expect(Buffer.from(first.nextCursor ?? "", "base64url").toString()).not.toContain("ses_")

    const rest = await viewer.activity.connections({
      userId: "marie",
      limit: 1,
      cursor: first.nextCursor,
    })
    expect(rest.connections.map((connection) => connection.status)).toEqual(["revoked"])
    expect(rest.nextCursor).toBeUndefined()

    await expect(stranger.activity.connections({ userId: "marie" })).rejects.toThrow("not allowed")
    await expect(
      viewer.activity.connections({ userId: "marie", cursor: "not-a-cursor" })
    ).rejects.toThrow("cursor")
  })

  // Guard proof: return `service.list(query)` unchanged from the runtime's list; the shared visit
  // keeps only its grant id. Read a share connection's status from its session alone; the revoked
  // link reads as active.
  test("shared visits are named by their link's share, read once for the page", async () => {
    const fixture = await createFixture()
    const { storage } = fixture

    await storage.shareGrants.create({
      id: "shr_invoice",
      projectId,
      definitionId: "invoiceShare",
      target: { objectTypeId: "Invoice", primaryId: "inv-1" },
      issuedBy: { type: "user", id: "marie" },
      authoritySnapshot: { version: 1, access: { grants: [] } },
      tokenHash: "a".repeat(64),
      destinationPath: "/invoices/inv-1",
      createdAt: start,
      expiresAt: new Date(start.getTime() + 24 * 60 * minute),
    })
    for (const grantId of ["shr_invoice", "shr_gone"]) {
      await storage.activity.append({
        projectId,
        actor: { type: "share", grantId },
        sessionId: `shs_${grantId}`,
        events: [{ id: grantId, type: "page.view", route: "/invoices/:invoiceId" }],
        now: start,
        idleTimeoutMs: 30 * minute,
        newVisitId: `visit_${grantId}`,
      })
    }
    await storage.shareSessions.create({
      id: "shs_shr_invoice",
      projectId,
      grantId: "shr_invoice",
      tokenHash: "b".repeat(64),
      createdAt: start,
      expiresAt: new Date(start.getTime() + 60 * minute),
      absoluteExpiresAt: new Date(start.getTime() + 24 * 60 * minute),
    })

    const reads: (readonly string[])[] = []
    const getByIds = storage.shareGrants.getByIds.bind(storage.shareGrants)
    storage.shareGrants.getByIds = (input) => {
      reads.push(input.ids)
      return getByIds(input)
    }

    const page = await fixture.viewer.activity.list({
      from: new Date(start.getTime() - minute),
      to: new Date(start.getTime() + minute),
    })

    expect(
      page.visits
        .map((visit) => visit.actor)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    ).toEqual([
      { type: "share", grantId: "shr_gone" },
      { type: "share", grantId: "shr_invoice", definitionId: "invoiceShare" },
    ])
    expect(reads).toHaveLength(1)

    const timeline = await fixture.viewer.activity.timeline("visit_shr_invoice")
    expect(timeline?.visit.actor).toEqual({
      type: "share",
      grantId: "shr_invoice",
      definitionId: "invoiceShare",
    })
    expect(timeline?.connection).toMatchObject({ type: "share", status: "active" })

    // A session lasts no longer than its link: revoking the grant ends it too.
    await storage.shareGrants.revoke({
      projectId,
      id: "shr_invoice",
      revokedAt: new Date(start.getTime() + minute),
      revokedBy: { type: "user", id: "marie" },
    })
    expect((await fixture.viewer.activity.timeline("visit_shr_invoice"))?.connection).toEqual({
      type: "share",
      grantId: "shr_invoice",
      definitionId: "invoiceShare",
      status: "revoked",
      createdAt: start,
      revokedAt: new Date(start.getTime() + minute),
    })
  })
})

// Guard proof: drop the unreadable types from runVisible in composeActivityTimeline; the sealed
// invoice's run reads as visible to sales.
test("an object a marking seals for the viewer is not linked, nor is its run", async () => {
  const app = await createAppliedProject({ activity: true })
  const trusted = createTestSixb(app.host)
  const storage = app.host.storage
  const appProject = app.host.id

  await trusted.objects(Customer).upsert({ properties: { id: "c1", name: "Acme" } })
  await trusted.objects(MarkedInvoice).upsert({
    properties: { id: "inv-1", customerId: "c1", title: "Boiler" },
  })
  // A version whose key column carried the marking: Invoice is sealed for whoever lacks it.
  app.apply(await app.normalized(null))

  await storage.auth?.users.create({ projectId: appProject, id: "marie", email: "m@example.test" })
  await storage.auth?.sessions.create({
    projectId: appProject,
    id: "ses_marie",
    userId: "marie",
    strategyId: "test",
    tokenHash: "hash-marie",
    createdAt: new Date(start.getTime() - minute),
    expiresAt: new Date(start.getTime() + 60 * minute),
  })
  const [visitId] = await pageViews(storage, { offsetsMs: [0], projectId: appProject })

  const root = await executionAt(storage, 10 * second, {
    ...request("root"),
    projectId: appProject,
  })
  await recordAction(
    storage,
    await executionAt(storage, 11 * second, primitive(root, "action", "archive-invoice", "act_1")),
    { objectTypeId: MarkedInvoice.id, primaryId: "inv-1" }
  )

  const actionOf = async (groups: readonly string[]) => {
    const reader = createTestSixb(app.host, { authorization: app.contextFor(groups) })
    const timeline = await reader.activity.timeline(visitId ?? "")
    return timeline?.entries.find((entry) => entry.kind === "action")
  }

  const sealed = await actionOf(["sales"])
  expect(sealed).toMatchObject({ runId: "act_1", runVisible: false })
  expect(sealed).not.toHaveProperty("object")
  expect(await actionOf(["finance"])).toMatchObject({
    runVisible: true,
    object: { objectTypeId: MarkedInvoice.id, primaryId: "inv-1" },
  })
})

test("user agents name common browsers and systems, and nothing else", () => {
  const cases: readonly (readonly [string | undefined, ReturnType<typeof describeUserAgent>])[] = [
    [chrome, { browser: "Chrome", os: "macOS" }],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      { browser: "Edge", os: "Windows" },
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      { browser: "Safari", os: "iOS" },
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
      { browser: "Chrome", os: "Android" },
    ],
    [
      "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
      { browser: "Firefox", os: "Linux" },
    ],
    ["curl/8.7.1", {}],
    [undefined, {}],
  ]

  for (const [userAgent, device] of cases) {
    expect(describeUserAgent(userAgent)).toEqual(device)
  }
})
