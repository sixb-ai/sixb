import { describe, expect, test } from "bun:test"
import {
  type AuthorizationContext,
  AuthorizationError,
  can,
  currentUser,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  defineRule,
  defineShare,
  link,
  ObjectNotFoundError,
  type ObjectQuery,
  objectRef,
  prop,
  ref,
  type SharedAccessInvitation,
  SixbHost,
  type StoredDomainEvent,
  userRef,
} from "../src"
import { agentServiceAccountId } from "../src/agents/authority"
import { restoreAgentExecutionScope } from "../src/execution/agent"
import {
  createAuthorizedObjectReader,
  getAuthorizedOntologyView,
} from "../src/execution/authorized-object-reader"
import { createTestingScope } from "../src/execution/scopes"
import type { OntologyRegistry } from "../src/ontology"
import type { AppliedMarkings } from "../src/security/applied-markings"
import { NO_APPLIED_MARKINGS } from "../src/security/applied-markings-snapshot"
import { SharedSessionProtocol } from "../src/shares/session-protocol"
import { createTestSixb } from "../src/testing"
import { resolveRolesWithConditions } from "./helpers/view-conditions"
import { createSharedTestScope } from "./shared-test-scope"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A support desk: tickets, incidents (a kind of ticket) and teams. Roles here hold conditional
// view grants, which a host still refuses at startup, so contexts are resolved beside the host.

const projectId = "view-condition-reads"
const filterable = { query: { searchable: true, filterable: true, facet: true } } as const

const Team = defineObjectType({
  id: "team",
  name: "Team",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link.ref("tickets", "ticket")],
})

const Ticket = defineObjectType({
  id: "ticket",
  name: "Ticket",
  properties: [
    prop("id", "string", {
      required: true,
      primary: true,
      query: { searchable: true, sortable: true },
    }),
    prop("status", "string", filterable),
    prop("owner", ref.user(), { nullable: true, ...filterable }),
    prop("temperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
    prop("attachment", "fileRef"),
  ],
  links: [link("team", Team, { cardinality: "one" })],
})

const Incident = defineObjectType({
  id: "incident",
  name: "Incident",
  extends: Ticket,
  properties: [],
})

const escalate = defineAction("escalate-ticket")
  .on(Ticket)
  .params({})
  .edits(() => {})

const ticketShare = defineShare("ticket-share", {
  target: Ticket,
  grants: ({ target }) => [can.view(target)],
})

const teamShare = defineShare("team-share", {
  target: Team,
  grants: ({ target }) => [can.view(target).withLinks([Team.l.tickets])],
})

const openTicket = defineRule("ticket.open")
  .on(Ticket)
  .where((ticket) => ticket.p.status.eq("open"))

const isOpen = can.view(Ticket).where((ticket) => ticket.p.status.eq("open"))
const isMine = can.view(Ticket).where((ticket) => ticket.p.owner.eq(currentUser()))
const isNotMine = can.view(Ticket).where((ticket) => ticket.p.owner.neq(currentUser()))

const roles = [
  defineRole("open-tickets", {
    grantedTo: [defineGroup("open")],
    grants: [isOpen, can.view(Team)],
  }),
  defineRole("my-tickets", { grantedTo: [defineGroup("mine")], grants: [isMine, can.view(Team)] }),
  defineRole("others-tickets", { grantedTo: [defineGroup("others")], grants: [isNotMine] }),
  defineRole("all-tickets", {
    grantedTo: [defineGroup("all")],
    grants: [can.view(Ticket), can.view(Team)],
  }),
  defineRole("incidents", { grantedTo: [defineGroup("incidents")], grants: [can.view(Incident)] }),
  defineRole("ticket-operator", {
    grantedTo: [defineGroup("open")],
    grants: [
      can.edit(Ticket),
      can.apply(escalate),
      can.share(ticketShare),
      can.share(teamShare),
      can.view(Team),
      can.edit(Team),
    ],
  }),
]

const alice = { type: "user", id: "usr_alice" } as const
const reports = { type: "serviceAccount", id: "svc_reports" } as const

async function deploy() {
  const host = new SixbHost({
    id: projectId,
    ontology: [Team, Ticket, Incident],
    actions: [escalate],
    shares: [ticketShare, teamShare],
    rules: [openTicket],
    ...createTestRuntimeDeps(),
  })
  const trusted = createTestSixb(host)

  for (const id of ["usr_alice", "usr_bob"]) {
    await host.storage.auth?.users.create({ projectId, id, email: `${id}@example.com` })
  }

  await trusted.objects(Team).upsert({ properties: { id: "team-1" } })

  const tickets = [
    { type: Ticket, id: "t-open-alice", status: "open", owner: userRef("usr_alice") },
    { type: Ticket, id: "t-closed-alice", status: "closed", owner: userRef("usr_alice") },
    { type: Ticket, id: "t-closed-bob", status: "closed", owner: userRef("usr_bob") },
    { type: Incident, id: "i-open-bob", status: "open", owner: userRef("usr_bob") },
    { type: Incident, id: "i-closed", status: "closed", owner: null },
  ] as const

  for (const { type, ...properties } of tickets) {
    const attachment = await host.blobStorage.put({
      body: new TextEncoder().encode(properties.id),
      fileName: `${properties.id}.txt`,
      mediaType: "text/plain",
    })

    await trusted.objects(type).upsert({ properties: { ...properties, attachment } })
    await trusted.objects.upsertLink(type.id, properties.id, "team", {
      targetTypeId: Team.id,
      targetId: "team-1",
    })
  }

  const { contextFor } = resolveRolesWithConditions({ ontology: [Team, Ticket, Incident], roles })
  const ontology = host.definitions.ontology as OntologyRegistry

  const readerFor = (
    groupIds: readonly string[],
    principal: AuthorizationContext["principal"] = alice,
    appliedMarkings?: AppliedMarkings
  ) =>
    createAuthorizedObjectReader({
      scope: createTestingScope({ projectId, context: contextFor(groupIds, principal) }),
      ontology,
      objectStorage: host.storage.objects,
      ...(appliedMarkings === undefined ? {} : { appliedMarkings }),
    })

  // The managed agent's service account, reading in a run a user requested.
  const agentReaderFor = (groupIds: readonly string[], requestedBy: typeof alice) => {
    const principal = { type: "serviceAccount", id: agentServiceAccountId("desk") } as const

    return createAuthorizedObjectReader({
      scope: restoreAgentExecutionScope({
        actorId: "desk",
        runId: "agent-run-1",
        authorization: { type: "principal", context: contextFor(groupIds, principal) },
        execution: {
          id: "agent-execution-1",
          projectId,
          requestedBy,
          requesterGroupIds: [],
          executor: { type: "agent", runId: "agent-run-1" },
          source: { type: "execution", executionId: "request-execution-1" },
          correlationId: "agent-correlation-1",
          authorizationRef: { type: "principal", principal },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      }),
      ontology,
      objectStorage: host.storage.objects,
    })
  }

  const sixbFor = (groupIds: readonly string[]) =>
    createTestSixb(host, { authorization: contextFor(groupIds) })

  return { host, trusted, readerFor, agentReaderFor, sixbFor }
}

type Reader = ReturnType<Awaited<ReturnType<typeof deploy>>["readerFor"]>

const tickets: ObjectQuery = { kind: "start", objectTypeId: Ticket.id }
const incidents: ObjectQuery = { kind: "start", objectTypeId: Incident.id }

/** The tickets and incidents a reader's queries return. */
async function visibleTickets(reader: Reader): Promise<readonly string[]> {
  const results = await Promise.all([
    reader.executeQuery({ query: tickets }),
    reader.executeQuery({ query: incidents }),
  ])
  return results.flatMap((result) => result.objects.map((row) => row.primaryId)).sort()
}

describe("reads through view conditions", () => {
  // Reproduce: return the unscoped store from objectStorageForAuthority for a principal, and
  // every read below sees the closed tickets too.
  test("every read terminal sees only the objects a condition matches", async () => {
    const { readerFor } = await deploy()
    const reader = readerFor(["open"])

    expect(await visibleTickets(reader)).toEqual(["i-open-bob", "t-open-alice"])

    expect(
      await reader.getByPrimaryId({ objectTypeId: Ticket.id, primaryId: "t-open-alice" })
    ).not.toBeNull()
    expect(
      await reader.getByPrimaryId({ objectTypeId: Ticket.id, primaryId: "t-closed-bob" })
    ).toBeNull()

    const batch = await reader.getByPrimaryIdBatch({
      items: [
        { objectTypeId: Ticket.id, primaryId: "t-open-alice" },
        { objectTypeId: Ticket.id, primaryId: "t-closed-alice" },
      ],
    })
    expect([...batch.values()].map((row) => row.primaryId)).toEqual(["t-open-alice"])

    const listed = await reader.list({ objectTypeId: [Ticket.id, Incident.id] })
    expect(listed.objects.map((row) => row.primaryId).sort()).toEqual([
      "i-open-bob",
      "t-open-alice",
    ])
    expect(listed.total).toBe(2)

    expect((await reader.count({ query: tickets })).count).toBe(1)
    expect(
      (
        await reader.exists({
          query: {
            kind: "filter",
            input: tickets,
            predicate: { op: "eq", propertyId: "status", value: "closed" },
          },
        })
      ).exists
    ).toBe(false)

    const facets = await reader.facet({
      query: tickets,
      facets: [{ propertyId: "status", limit: 10 }],
    })
    expect(facets.facets[0]?.buckets).toEqual([{ value: "open", count: 1 }])
  })

  test("links and traversals reach only the objects a condition matches", async () => {
    const { readerFor } = await deploy()
    const reader = readerFor(["open"])

    const fromTeam = await reader.listLinks({
      objectTypeId: Team.id,
      objectId: "team-1",
      linkId: "team",
      direction: "incoming",
    })
    expect(fromTeam.map((row) => row.sourceId).sort()).toEqual(["i-open-bob", "t-open-alice"])

    const queried = await reader.queryLinks({
      query: { kind: "refs", refs: [{ objectTypeId: Team.id, primaryId: "team-1" }] },
      direction: "incoming",
      linkId: "team",
    })
    expect(queried.links.map((row) => row.sourceId).sort()).toEqual(["i-open-bob", "t-open-alice"])

    const traversed = await reader.executeQuery({
      query: {
        kind: "traverse",
        input: { kind: "start", objectTypeId: Team.id },
        linkId: "team",
        direction: "incoming",
      },
    })
    expect(traversed.objects.map((row) => row.primaryId).sort()).toEqual([
      "i-open-bob",
      "t-open-alice",
    ])
  })

  // A file opens through the object that holds it, read through the reader like any other read.
  test("an object's files open only while its condition matches it", async () => {
    const { sixbFor } = await deploy()
    const tickets = sixbFor(["open"]).objects(Ticket)

    expect(await tickets.byId("t-open-alice").file(Ticket.p.attachment).open()).not.toBeNull()
    expect(await tickets.byId("t-closed-bob").file(Ticket.p.attachment).open()).toBeNull()
  })

  // Reproduce: filter the principal's ontology view on view:object alone, and the app no longer
  // lists the tickets this reader can open.
  test("the reader's ontology lists a type it views through a condition", async () => {
    const { readerFor } = await deploy()
    const listed = getAuthorizedOntologyView(readerFor(["open"]))
      .listObjectTypes()
      .map((objectType) => objectType.id)

    expect(listed.sort()).toEqual(["incident", "team", "ticket"])
  })

  test("a reader sees the union of its grants", async () => {
    const { readerFor } = await deploy()

    // Two conditions: an object either matches is visible.
    expect(await visibleTickets(readerFor(["open", "mine"]))).toEqual([
      "i-open-bob",
      "t-closed-alice",
      "t-open-alice",
    ])

    // An unconditional grant from any role shows every object.
    expect(await visibleTickets(readerFor(["open", "all"]))).toEqual([
      "i-closed",
      "i-open-bob",
      "t-closed-alice",
      "t-closed-bob",
      "t-open-alice",
    ])

    // A condition on the parent applies to its subtypes, unless the subtype is granted whole.
    expect(await visibleTickets(readerFor(["open", "incidents"]))).toEqual([
      "i-closed",
      "i-open-bob",
      "t-open-alice",
    ])
  })

  // Reproduce: bind the conditions without the reader's user, and Alice matches none of hers.
  test("currentUser() in a condition stands for the user reading, and for nobody else", async () => {
    const { readerFor } = await deploy()

    expect(await visibleTickets(readerFor(["mine"], alice))).toEqual([
      "t-closed-alice",
      "t-open-alice",
    ])
    expect(await visibleTickets(readerFor(["mine"], reports))).toEqual([])

    // Without a user, neq stays the complement of eq: it matches every object.
    expect(await visibleTickets(readerFor(["others"], reports))).toHaveLength(5)
    expect(await visibleTickets(readerFor(["others"], alice))).toEqual([
      "i-closed",
      "i-open-bob",
      "t-closed-bob",
    ])
  })

  // Reproduce: bind the conditions in ObjectReaderSecurity to execution.requestedBy, and the
  // agent reads Alice's tickets as hers.
  test("currentUser() in a condition is the grant's principal, not the user it runs for", async () => {
    const { agentReaderFor } = await deploy()

    expect(await visibleTickets(agentReaderFor(["mine"], alice))).toEqual([])
    expect(await visibleTickets(agentReaderFor(["others"], alice))).toHaveLength(5)
  })

  // Reproduce: drop the condition check from ObjectReaderSecurity.isObjectTypeGranted and
  // assertObjectTypesGranted; the matching tickets are read, which reveals the marked status.
  test("a condition whose property a dataset version marks hides the whole type", async () => {
    const { readerFor } = await deploy()
    const marked = {
      ...NO_APPLIED_MARKINGS,
      properties: new Map([
        [Ticket.id, new Map([["status", new Set(["support"])]])],
        [Incident.id, new Map([["status", new Set(["support"])]])],
      ]),
      markings: new Set(["support"]),
    }
    const applied: AppliedMarkings = {
      affects: () => true,
      current: async () => marked,
      invalidate: () => {},
      forEventOrigin: async (snapshot) => snapshot,
      forEarlierValues: (snapshot) => snapshot,
    }
    const reader = readerFor(["open"], alice, applied)

    const denial = await reader
      .getByPrimaryId({ objectTypeId: Ticket.id, primaryId: "t-open-alice" })
      .catch((error) => error)
    expect(denial).toBeInstanceOf(AuthorizationError)
    expect((denial as AuthorizationError).message).toBe(
      "[Sixb] Cannot read 'ticket': the condition it is viewed through reads 'ticket.status', which requires clearance for marking 'support'."
    )

    expect(await reader.executeQuery({ query: tickets }).catch((error) => error)).toBeInstanceOf(
      AuthorizationError
    )

    // A listing that names no type leaves the hidden types out, and still reads the others.
    const listed = await reader.list({})
    expect(listed.objects.map((row) => row.objectTypeId)).toEqual(["team"])
  })
})

// The surfaces below decide on view:object, which a conditional grant never fills. Each test is a
// guard a later change opens deliberately, by reading through the conditions there.
describe("surfaces that do not apply view conditions deny the type", () => {
  test("telemetry reads", async () => {
    const { sixbFor } = await deploy()
    const reader = sixbFor(["open"])

    const denial = await reader.objects
      .getLatestTelemetry({
        objectTypeId: Ticket.id,
        objectId: "t-open-alice",
        propertyId: "temperature",
      })
      .catch((error) => error)
    expect(denial).toBeInstanceOf(AuthorizationError)
  })

  test("telemetry appends", async () => {
    const { sixbFor } = await deploy()

    const denial = await sixbFor(["open"])
      .objects(Ticket)
      .byId("t-open-alice")
      .telemetry(Ticket.p.temperature)
      .append({ value: 21, unit: "degreeCelsius", at: new Date(0) })
      .catch((error: unknown) => error)
    expect(denial).toBeInstanceOf(AuthorizationError)
  })

  test("direct writes, link writes included", async () => {
    const { host, sixbFor } = await deploy()
    const operator = sixbFor(["open"])

    const upsert = await operator
      .objects(Ticket)
      .upsert({ properties: { id: "t-open-alice", status: "open" } })
      .catch((error) => error)
    expect(upsert).toBeInstanceOf(AuthorizationError)

    const linked = await operator.objects
      .upsertLink(Ticket.id, "t-open-alice", "team", { targetTypeId: Team.id, targetId: "team-1" })
      .catch((error) => error)
    expect(linked).toBeInstanceOf(AuthorizationError)

    expect(
      (
        await host.storage.objects.getByPrimaryId({
          projectId,
          objectTypeId: Ticket.id,
          primaryId: "t-open-alice",
        })
      )?.version
    ).toBe(1)
  })

  test("action requests and runs", async () => {
    const { host, trusted, sixbFor } = await deploy()
    const operator = sixbFor(["open"])
    const subject = { kind: "object", objectTypeId: Ticket.id, primaryId: "t-open-alice" } as const

    const requested = await operator.actions
      .request({ actionId: escalate.id, subject, runId: "act_operator" })
      .catch((error) => error)
    expect(requested).toBeInstanceOf(AuthorizationError)
    expect(await host.storage.actionRuns?.getById({ projectId, id: "act_operator" })).toBeNull()

    // A run someone else requested on a ticket the operator reads stays out of its history.
    await trusted.actions.request({ actionId: escalate.id, subject, runId: "act_trusted" })
    expect(await operator.actions.runs.getById("act_trusted")).toBeNull()
    expect((await operator.actions.runs.list()).runs).toEqual([])
  })

  test("events", async () => {
    const { sixbFor } = await deploy()
    const created = (events: readonly StoredDomainEvent[]) =>
      events.flatMap((event) =>
        event.type === "object.created"
          ? [`${event.payload.objectTypeId}:${event.payload.primaryId}`]
          : []
      )

    // The log holds the open ticket's creation: a reader of every ticket gets it.
    expect(created(await sixbFor(["all"]).events.read())).toContain("ticket:t-open-alice")

    expect(created(await sixbFor(["open"]).events.read())).toEqual(["team:team-1"])
  })

  test("rules", async () => {
    const { sixbFor } = await deploy()
    const operator = sixbFor(["open"])

    expect(operator.rules.list()).toEqual([])
    expect(operator.rules.getById(openTicket.id)).toBeNull()
  })
})

describe("share issuance through view conditions", () => {
  const until = new Date("2099-01-01T00:00:00.000Z")

  const issueTicket = (sixb: ReturnType<Deployed["sixbFor"]>, primaryId: string) =>
    sixb.shares.issue(ticketShare, {
      target: objectRef(Ticket, primaryId),
      destinationPath: `/tickets/${primaryId}`,
      expiresAt: until,
    })

  // Reproduce: require a whole view of the target's type in shares/execution.ts; the operator,
  // who reads the open ticket through its condition, cannot share it.
  test("shares a target its issuer sees through a condition, and the link shows it", async () => {
    const { host, sixbFor } = await deploy()

    const invitation = await issueTicket(sixbFor(["open"]), "t-open-alice")
    expect(invitation.grant.target).toEqual({ objectTypeId: Ticket.id, primaryId: "t-open-alice" })

    const recipient = await recipientOf(host, invitation)
    expect(await recipient.objects(Ticket).get("t-open-alice")).toMatchObject({
      primaryId: "t-open-alice",
    })
    expect(await recipient.objects(Ticket).get("t-closed-alice")).toBeNull()
  })

  // Reproduce: drop the target read from shares/execution.ts; the operator shares a closed ticket
  // its condition hides.
  test("refuses a target the condition hides exactly like a missing one", async () => {
    const { host, sixbFor } = await deploy()
    const operator = sixbFor(["open"])

    const hidden = await issueTicket(operator, "t-closed-bob").catch((error) => error)
    const missing = await issueTicket(operator, "t-missing").catch((error) => error)

    expect(hidden).toBeInstanceOf(ObjectNotFoundError)
    expect(missing).toBeInstanceOf(ObjectNotFoundError)
    expect((hidden as Error).message.replace("t-closed-bob", "<id>")).toBe(
      (missing as Error).message.replace("t-missing", "<id>")
    )

    const issued = await host.storage.shareGrants?.list({
      projectId,
      definitionId: ticketShare.id,
      now: new Date(),
    })
    expect(issued?.total).toBe(0)
  })

  // The decided behavior: a link holds its own grants, not its issuer's condition.
  test("keeps showing the target after it stops matching the issuer's condition", async () => {
    const { host, trusted, sixbFor } = await deploy()
    const operator = sixbFor(["open"])

    const invitation = await issueTicket(operator, "t-open-alice")
    await trusted.objects(Ticket).upsert({ properties: { id: "t-open-alice", status: "closed" } })

    expect(await operator.objects(Ticket).get("t-open-alice")).toBeNull()

    const recipient = await recipientOf(host, invitation)
    expect(await recipient.objects(Ticket).get("t-open-alice")).toMatchObject({
      primaryId: "t-open-alice",
      properties: { status: "closed" },
    })
  })

  // Reproduce: drop the linked-type check from shares/execution.ts; the operator, who views teams
  // whole, shares team-1 with every ticket it links to, those it cannot read included.
  test("refuses links to a type its issuer sees only through a condition", async () => {
    const { sixbFor } = await deploy()

    const denial = await sixbFor(["open"])
      .shares.issue(teamShare, {
        target: objectRef(Team, "team-1"),
        destinationPath: "/teams/team-1",
        expiresAt: until,
      })
      .catch((error) => error)
    expect(denial).toBeInstanceOf(AuthorizationError)
    expect((denial as AuthorizationError).message).toBe(
      "[Sixb] Principal 'usr_reader' cannot issue Share 'team-share', whose links show every object of 'incident', 'ticket' they reach: the principal views these types only through a condition, or not at all. Grant can.view() on them without a condition, or leave their links out of the Share."
    )
  })

  test("an issuer viewing the type whole shares any of its objects", async () => {
    const { host, sixbFor } = await deploy()
    const operator = sixbFor(["open", "all"])

    const ticket = await issueTicket(operator, "t-closed-bob")
    const recipient = await recipientOf(host, ticket)
    expect(await recipient.objects(Ticket).get("t-closed-bob")).not.toBeNull()

    const team = await operator.shares.issue(teamShare, {
      target: objectRef(Team, "team-1"),
      destinationPath: "/teams/team-1",
      expiresAt: until,
    })
    expect(team.grant.definitionId).toBe(teamShare.id)
  })
})

type Deployed = Awaited<ReturnType<typeof deploy>>

/** The Sixb a link's recipient reads through, in the session its secret opens. */
async function recipientOf(host: Deployed["host"], invitation: SharedAccessInvitation) {
  const credential = await new SharedSessionProtocol({ host }).exchange(
    invitation.grant.id,
    invitation.secret
  )
  if (!credential) throw new Error("The link's secret opened no session.")

  const { grantId, sessionId, access } = credential.context

  return host.withScope(
    createSharedTestScope({
      projectId,
      requestId: `shared-request-${sessionId}`,
      correlationId: `shared-correlation-${sessionId}`,
      access,
      delegation: { kind: "share", grantId, sessionId },
    })
  )
}
