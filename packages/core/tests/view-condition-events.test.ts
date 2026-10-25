import { afterEach, describe, expect, spyOn, test } from "bun:test"
import {
  type AuthorizationContext,
  can,
  currentUser,
  defineGroup,
  defineMarking,
  defineObjectType,
  defineRole,
  defineRule,
  link,
  prop,
  type RuleDefinition,
  ref,
  SixbHost,
  type StoredDomainEvent,
  userRef,
} from "../src"
import { DomainEventService } from "../src/events"
import { getAppliedMarkings } from "../src/security/applied-markings-host"
import { NO_APPLIED_MARKINGS } from "../src/security/applied-markings-snapshot"
import type { ObjectReadStorage } from "../src/storage"
import { InMemoryObjectStorage } from "../src/storage/objects/in-memory"
import { createTestSixb } from "../src/testing"
import { contextIn, groupsOf } from "./helpers/view-conditions"
import { createTestRuntimeDeps, waitFor } from "./test-runtime-deps"

// Tickets assigned to teams.

const projectId = "view-condition-events"
const filterable = { query: { searchable: true, filterable: true } } as const
const restricted = defineMarking("restricted")

const Team = defineObjectType({
  id: "team",
  name: "Team",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Ticket = defineObjectType({
  id: "ticket",
  name: "Ticket",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string", filterable),
    prop("owner", ref.user(), { nullable: true, ...filterable }),
    prop("notes", "string", filterable),
    prop("cost", "double", { markings: [restricted] }),
    prop("temperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
  ],
  links: [link("team", Team, { cardinality: "one" })],
})

const openTicket = defineRule("ticket.open")
  .on(Ticket)
  .where((ticket) => ticket.p.status.eq("open"))

const watchedTeam = defineRule("team.watched")
  .on(Team)
  .where((team) => team.not(team.p.id.eq("")))

const roles = [
  defineRole("open-tickets", {
    grantedTo: [defineGroup("open")],
    grants: [can.view(Ticket).where((ticket) => ticket.p.status.eq("open")), can.view(Team)],
  }),
  defineRole("my-tickets", {
    grantedTo: [defineGroup("mine")],
    grants: [can.view(Ticket).where((ticket) => ticket.p.owner.eq(currentUser())), can.view(Team)],
  }),
  defineRole("all-tickets", {
    grantedTo: [defineGroup("all")],
    grants: [can.view(Ticket), can.view(Team)],
  }),
  defineRole("noted-tickets", {
    grantedTo: [defineGroup("noted")],
    grants: [can.view(Ticket).where((ticket) => ticket.p.notes.eq("vip")), can.view(Team)],
  }),
]

const alice = { type: "user", id: "usr_alice" } as const
const bob = { type: "user", id: "usr_bob" } as const
const reports = { type: "serviceAccount", id: "svc_reports" } as const

async function deploy() {
  const host = new SixbHost({
    id: projectId,
    ontology: [Team, Ticket],
    markings: [restricted],
    rules: [openTicket, watchedTeam],
    groups: groupsOf(roles),
    roles,
    ...createTestRuntimeDeps(),
  })
  const trusted = createTestSixb(host)

  for (const id of ["usr_alice", "usr_bob"]) {
    await host.storage.auth?.users.create({ projectId, id, email: `${id}@example.com` })
  }
  await trusted.objects(Team).upsert({ properties: { id: "team-1" } })
  await waitFor(
    () => host.events.read(),
    (events) => events.length === 1
  )

  const sixbFor = (
    groupIds: readonly string[],
    principal: AuthorizationContext["principal"] = alice
  ) => createTestSixb(host, { authorization: contextIn(host, groupIds, principal) })

  return { host, trusted, sixbFor }
}

type Deployment = Awaited<ReturnType<typeof deploy>>
type Reader = ReturnType<Deployment["sixbFor"]>

/** One line per event: what it is and which objects it names. */
function describeEvent(event: StoredDomainEvent): string {
  switch (event.topic) {
    case "objects":
      return `${event.type} ${event.payload.primaryId}`
    case "links":
      return `${event.type} ${event.payload.sourceId}->${event.payload.targetId}`
    case "telemetry":
      return `${event.type} ${event.payload.objectId}`
    case "rules":
      return `${event.type} ${event.payload.subject.primaryId}`
    default:
      return event.type
  }
}

/** What a reader is shown of the events about tickets, sorted: commits are logged in any order. */
async function shown(reader: Reader): Promise<readonly string[]> {
  const events = await reader.events.read()
  return events
    .map(describeEvent)
    .filter((line) => line !== "object.created team-1")
    .sort()
}

/** Wait for the log to hold every event about tickets, which a reader of every ticket is shown. */
async function logged({ sixbFor }: Deployment, expected: readonly string[]): Promise<void> {
  const reader = sixbFor(["all"])
  const lines = await waitFor(
    () => shown(reader),
    (lines) => lines.length >= expected.length
  )
  expect(lines).toEqual([...expected].sort())
}

async function createTicket(
  { trusted }: Deployment,
  properties: { readonly id: string; readonly status: string; readonly owner?: string }
): Promise<void> {
  await trusted.objects(Ticket).upsert({
    properties: {
      id: properties.id,
      status: properties.status,
      owner: properties.owner === undefined ? null : userRef(properties.owner),
    },
  })
}

async function triggerRule(
  host: SixbHost,
  primaryId: string,
  rule: RuleDefinition = openTicket
): Promise<void> {
  const [triggered] = await host.events.append({
    events: [
      {
        type: "rule.triggered",
        payload: {
          ruleId: rule.id,
          subject: { kind: "object", objectTypeId: rule.subject.objectTypeId, primaryId },
          triggeredAt: "2026-10-24T00:00:00.000Z",
        },
      },
    ],
  })
  if (triggered?.type !== "rule.triggered") throw new Error("[Test] Expected a rule event.")

  await host.storage.rules?.applyTriggered(triggered)
}

async function resolveRule(host: SixbHost, primaryId: string): Promise<void> {
  await host.events.append({
    events: [
      {
        type: "rule.resolved",
        payload: {
          ruleId: openTicket.id,
          subject: { kind: "object", objectTypeId: Ticket.id, primaryId },
          resolvedAt: "2026-10-24T00:00:00.000Z",
        },
      },
    ],
  })
}

describe("events follow view conditions", () => {
  // Reproduce: return true for "objects" in decide() of events/view-conditions.ts; the closed
  // ticket's creation and the update that closes the other one are delivered.
  test("a creation or an update shows while the state it carries matches", async () => {
    const deployment = await deploy()
    const { trusted, sixbFor } = deployment

    await createTicket(deployment, { id: "t-1", status: "open" })
    await createTicket(deployment, { id: "t-2", status: "closed" })
    await trusted.objects(Ticket).upsert({ properties: { id: "t-2", status: "open" } })
    await trusted.objects(Ticket).upsert({ properties: { id: "t-1", status: "closed" } })
    await logged(deployment, [
      "object.created t-1",
      "object.created t-2",
      "object.updated t-1",
      "object.updated t-2",
    ])

    // The update that closes t-1 hides it, so it is not delivered: the reader's copy stays stale.
    expect(await shown(sixbFor(["open"]))).toEqual(["object.created t-1", "object.updated t-2"])
  })

  // Reproduce: drop withoutHiddenPriorState from events/execution.ts, and the update that opens
  // t-2 tells the reader what it held while closed.
  test("an update that reveals an object carries none of the values it held hidden", async () => {
    const deployment = await deploy()
    const { trusted, sixbFor } = deployment

    await trusted
      .objects(Ticket)
      .upsert({ properties: { id: "t-1", status: "open", notes: "first" } })
    await trusted.objects(Ticket).upsert({
      properties: { id: "t-2", status: "closed", notes: "hidden", owner: userRef(bob.id) },
    })
    await trusted
      .objects(Ticket)
      .upsert({ properties: { id: "t-1", status: "open", notes: "second" } })
    await trusted
      .objects(Ticket)
      .upsert({ properties: { id: "t-2", status: "open", notes: "shown", owner: null } })
    await logged(deployment, [
      "object.created t-1",
      "object.created t-2",
      "object.updated t-1",
      "object.updated t-2",
    ])

    const changes = async (primaryId: string) => {
      const events = await sixbFor(["open"]).events.read()
      const updated = events.find(
        (event) =>
          event.type === "object.updated" &&
          event.topic === "objects" &&
          event.payload.primaryId === primaryId
      )
      return updated?.topic === "objects" ? updated.payload.propertyChanges : undefined
    }

    // t-2 appears to this reader with its new values, and nothing of its closed state.
    expect(await changes("t-2")).toEqual({
      status: { operation: "created", after: "open" },
      notes: { operation: "created", after: "shown" },
      owner: { operation: "created", after: null },
    })

    // An update of an object the reader saw before keeps what it replaced.
    expect(await changes("t-1")).toEqual({
      notes: { operation: "updated", before: "first", after: "second" },
    })
  })

  // Reproduce: rewrite a cleared change as created in withoutHiddenPriorState, and the reader
  // receives the change of a property it never saw.
  test("an update that reveals an object leaves out what it cleared", async () => {
    const deployment = await deploy()
    const { host, trusted, sixbFor } = deployment

    await trusted
      .objects(Ticket)
      .upsert({ properties: { id: "t-1", status: "closed", notes: "hidden" } })
    await trusted.objects(Ticket).upsert({ properties: { id: "t-1", status: "open" } })
    await logged(deployment, ["object.created t-1", "object.updated t-1"])

    // Object writes merge, so the update a projection makes when a column empties is built from
    // the real one: it reopens t-1 and clears its notes. The event stream shows a batch the same way.
    const [real] = await host.events.read({ types: ["object.updated"] })
    if (real?.type !== "object.updated") throw new Error("[Test] Expected the reopening update.")
    const { notes: _notes, ...properties } = real.payload.properties
    const clearing = {
      ...real,
      payload: {
        ...real.payload,
        properties,
        propertyChanges: {
          ...real.payload.propertyChanges,
          notes: { operation: "cleared" as const, before: "hidden", after: null },
        },
      },
    }

    const [shown] = await sixbFor(["open"]).events.visible([clearing])
    expect(shown?.topic === "objects" ? shown.payload.propertyChanges : undefined).toEqual({
      status: { operation: "created", after: "open" },
    })
  })

  // Reproduce: decide a deletion on its (empty) properties instead of its last state in
  // events/view-conditions.ts; neither deletion is delivered.
  test("a deletion shows when the object matched in its last state", async () => {
    const deployment = await deploy()
    const { trusted, sixbFor } = deployment

    await createTicket(deployment, { id: "t-open", status: "open" })
    await createTicket(deployment, { id: "t-closed", status: "closed" })
    await trusted.objects(Ticket).byId("t-open").delete()
    await trusted.objects(Ticket).byId("t-closed").delete()
    await logged(deployment, [
      "object.created t-closed",
      "object.created t-open",
      "object.deleted t-closed",
      "object.deleted t-open",
    ])

    expect(await shown(sixbFor(["open"]))).toEqual([
      "object.created t-open",
      "object.deleted t-open",
    ])
  })

  // Reproduce: return true for "links" in decide() of events/view-conditions.ts; the link to the
  // closed ticket is delivered.
  test("a link shows while both its ends are visible", async () => {
    const deployment = await deploy()
    const { trusted, sixbFor } = deployment

    for (const [id, status] of [
      ["t-open", "open"],
      ["t-closed", "closed"],
    ] as const) {
      await createTicket(deployment, { id, status })
      await trusted.objects.upsertLink(Ticket.id, id, "team", {
        targetTypeId: Team.id,
        targetId: "team-1",
      })
    }
    await logged(deployment, [
      "link.created t-closed->team-1",
      "link.created t-open->team-1",
      "object.created t-closed",
      "object.created t-open",
    ])

    expect(await shown(sixbFor(["open"]))).toEqual([
      "link.created t-open->team-1",
      "object.created t-open",
    ])
  })

  // Reproduce: in visibleUnderConditions() of events/view-conditions.ts, keep only `seenNow` and
  // t-open's link deletion and rule resolution are withheld, here and when shown on their own.
  // Return true from seenBeforeDeletion()'s lookups instead, and t-closed's are delivered.
  test("deleting an object tells the readers who saw it what the deletion removed", async () => {
    const deployment = await deploy()
    const { host, trusted, sixbFor } = deployment

    for (const [id, status] of [
      ["t-open", "open"],
      ["t-closed", "closed"],
    ] as const) {
      await createTicket(deployment, { id, status })
      await trusted.objects.upsertLink(Ticket.id, id, "team", {
        targetTypeId: Team.id,
        targetId: "team-1",
      })
      await triggerRule(host, id)
      await trusted.objects(Ticket).byId(id).delete()
      await resolveRule(host, id)
    }
    await logged(deployment, [
      "link.created t-closed->team-1",
      "link.created t-open->team-1",
      "link.deleted t-closed->team-1",
      "link.deleted t-open->team-1",
      "object.created t-closed",
      "object.created t-open",
      "object.deleted t-closed",
      "object.deleted t-open",
      "rule.resolved t-closed",
      "rule.resolved t-open",
      "rule.triggered t-closed",
      "rule.triggered t-open",
    ])

    // Read back once both are gone, each event is decided on what its ticket held then.
    const reader = sixbFor(["open"])
    expect(await shown(reader)).toEqual([
      "link.created t-open->team-1",
      "link.deleted t-open->team-1",
      "object.created t-open",
      "object.deleted t-open",
      "rule.resolved t-open",
      "rule.triggered t-open",
    ])

    // Delivered on its own, apart from the deletion that caused it, a link deletion decides alike.
    const removals = await host.events.read({ types: ["link.deleted"] })
    const alone = await Promise.all(removals.map((event) => reader.events.visible([event])))
    expect(alone.flat().map(describeEvent)).toEqual(["link.deleted t-open->team-1"])
  })

  // Reproduce: in seenBeforeDeletion() of events/view-conditions.ts, look every unseen object up
  // in the log, whether or not it still exists; the link to t-1, open when it was made, shows.
  test("an event about an object that still exists shows while it is visible now", async () => {
    const deployment = await deploy()
    const { trusted, sixbFor } = deployment

    await createTicket(deployment, { id: "t-1", status: "open" })
    await trusted.objects.upsertLink(Ticket.id, "t-1", "team", {
      targetTypeId: Team.id,
      targetId: "team-1",
    })
    await trusted.objects(Ticket).upsert({ properties: { id: "t-1", status: "closed" } })
    await logged(deployment, [
      "link.created t-1->team-1",
      "object.created t-1",
      "object.updated t-1",
    ])

    expect(await shown(sixbFor(["open"]))).toEqual(["object.created t-1"])
  })

  // Reproduce: return true for "telemetry" in decide() of events/view-conditions.ts.
  test("telemetry shows while its object is visible", async () => {
    const deployment = await deploy()
    const { trusted, sixbFor } = deployment

    for (const [id, status] of [
      ["t-open", "open"],
      ["t-closed", "closed"],
    ] as const) {
      await createTicket(deployment, { id, status })
      await trusted
        .objects(Ticket)
        .byId(id)
        .telemetry(Ticket.p.temperature)
        .append({ value: 21, unit: "degreeCelsius", at: new Date(0) })
    }
    // A point also updates the object's latest value.
    await logged(deployment, [
      "object.created t-closed",
      "object.created t-open",
      "object.updated t-closed",
      "object.updated t-open",
      "telemetry.appended t-closed",
      "telemetry.appended t-open",
    ])

    expect(await shown(sixbFor(["open"]))).toEqual([
      "object.created t-open",
      "object.updated t-open",
      "telemetry.appended t-open",
    ])
  })

  // Reproduce: return true for "rules" in decide() of events/view-conditions.ts.
  test("a rule transition shows while its object is visible", async () => {
    const deployment = await deploy()
    const { host, sixbFor } = deployment

    await createTicket(deployment, { id: "t-open", status: "open" })
    await createTicket(deployment, { id: "t-closed", status: "closed" })
    await triggerRule(host, "t-closed")
    await triggerRule(host, "t-open")
    await logged(deployment, [
      "object.created t-closed",
      "object.created t-open",
      "rule.triggered t-closed",
      "rule.triggered t-open",
    ])

    expect(await shown(sixbFor(["open"]))).toEqual([
      "object.created t-open",
      "rule.triggered t-open",
    ])
  })

  test("a reader sees the union of its grants", async () => {
    const deployment = await deploy()
    const { sixbFor } = deployment

    await createTicket(deployment, { id: "t-open-bob", status: "open", owner: "usr_bob" })
    await createTicket(deployment, { id: "t-closed-alice", status: "closed", owner: "usr_alice" })
    await createTicket(deployment, { id: "t-closed-bob", status: "closed", owner: "usr_bob" })
    await logged(deployment, [
      "object.created t-closed-alice",
      "object.created t-closed-bob",
      "object.created t-open-bob",
    ])

    expect(await shown(sixbFor(["open", "mine"], alice))).toEqual([
      "object.created t-closed-alice",
      "object.created t-open-bob",
    ])
    expect(await shown(sixbFor(["open", "all"], alice))).toHaveLength(3)
  })

  // Reproduce: bind the conditions without the reader's user in ObjectReaderSecurity; Alice and
  // Bob are shown none of their tickets.
  test("currentUser() in a condition stands for the user reading, and for nobody else", async () => {
    const deployment = await deploy()
    const { sixbFor } = deployment

    await createTicket(deployment, { id: "t-alice", status: "open", owner: "usr_alice" })
    await createTicket(deployment, { id: "t-bob", status: "open", owner: "usr_bob" })
    await createTicket(deployment, { id: "t-nobody", status: "open" })
    await logged(deployment, [
      "object.created t-alice",
      "object.created t-bob",
      "object.created t-nobody",
    ])

    expect(await shown(sixbFor(["mine"], alice))).toEqual(["object.created t-alice"])
    expect(await shown(sixbFor(["mine"], bob))).toEqual(["object.created t-bob"])
    expect(await shown(sixbFor(["mine"], reports))).toEqual([])
  })

  test("markings redact what a conditioned reader is shown", async () => {
    const deployment = await deploy()
    const { trusted, sixbFor } = deployment

    await trusted.objects(Ticket).upsert({ properties: { id: "t-1", status: "open", cost: 12 } })
    await logged(deployment, ["object.created t-1"])

    const created = (await sixbFor(["open"]).events.read()).find(
      (event) => event.type === "object.created" && event.payload.primaryId === "t-1"
    )
    expect(created?.topic === "objects" && created.payload).toMatchObject({
      properties: { id: "t-1", status: "open" },
      redactions: { cost: { reason: "missing_clearance" } },
    })
  })

  // Reproduce: drop the hiddenBy check for "objects" in decide() of events/view-conditions.ts;
  // the ticket's update is delivered, which reveals that its marked notes read "vip". Dropping it
  // from namedObjects() fails the link and rule events' read instead of withholding them. Dropping
  // it from rules.states.list in rules/execution.ts fails the listing instead of leaving it empty.
  test("a condition that reads a property the reader is not cleared for hides its type", async () => {
    const deployment = await deploy()
    const { host, trusted, sixbFor } = deployment

    await createTicket(deployment, { id: "t-1", status: "open" })
    await trusted.objects(Ticket).upsert({ properties: { id: "t-1", notes: "vip" } })
    await trusted.objects.upsertLink(Ticket.id, "t-1", "team", {
      targetTypeId: Team.id,
      targetId: "team-1",
    })
    await triggerRule(host, "t-1")
    await logged(deployment, [
      "link.created t-1->team-1",
      "object.created t-1",
      "object.updated t-1",
      "rule.triggered t-1",
    ])
    expect(await shown(sixbFor(["noted"]))).toEqual([
      "link.created t-1->team-1",
      "object.updated t-1",
      "rule.triggered t-1",
    ])

    // A dataset version marks the notes the condition reads, as a projection would apply it.
    markAppliedNotes(host)

    expect(await shown(sixbFor(["noted"]))).toEqual([])
    expect(
      await sixbFor(["noted"]).rules.states.list({ objectTypeId: Ticket.id, primaryId: "t-1" })
    ).toEqual({ states: [], hasMore: false, total: 0 })
  })

  // Reproduce: subscribe without filtering through `visible` in events/execution.ts; the closed
  // ticket's creation is delivered first.
  test("a subscription delivers only the events the reader sees", async () => {
    const deployment = await deploy()
    const { promise: delivered, resolve } = Promise.withResolvers<readonly string[]>()
    const unsubscribe = await deployment
      .sixbFor(["open"])
      .events.subscribe({}, (events) => resolve(events.map(describeEvent)))

    try {
      await createTicket(deployment, { id: "t-closed", status: "closed" })
      await createTicket(deployment, { id: "t-open", status: "open" })

      expect(await delivered).toEqual(["object.created t-open"])
    } finally {
      unsubscribe()
    }
  })
})

describe("what a reader pays for view conditions", () => {
  const spies: { mockRestore(): void }[] = []
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore()
  })

  /**
   * Count the object batch reads of the in-memory store: those of unscoped readers, and those of
   * readers that read through conditions. Then the objects looked up in the event log.
   */
  function countBatchReads() {
    const reads = { unscoped: [] as number[], conditional: [] as number[], logged: 0 }
    const store = InMemoryObjectStorage.prototype

    const lookup = DomainEventService.prototype.lastObjectEventBefore
    spies.push(
      spyOn(DomainEventService.prototype, "lastObjectEventBefore").mockImplementation(function (
        this: DomainEventService,
        input
      ) {
        reads.logged += 1
        return lookup.call(this, input)
      })
    )

    const batch = store.getByPrimaryIdBatch
    spies.push(
      spyOn(store, "getByPrimaryIdBatch").mockImplementation(function (
        this: InMemoryObjectStorage,
        input
      ) {
        reads.unscoped.push(input.items.length)
        return batch.call(this, input)
      })
    )

    const conditional = store.createConditionalReadScope
    spies.push(
      spyOn(store, "createConditionalReadScope").mockImplementation(function (
        this: InMemoryObjectStorage,
        input
      ) {
        return countingBatches(conditional.call(this, input), reads.conditional)
      })
    )

    return reads
  }

  /** Two tickets, each linked, measured and matching a rule: ten events about tickets. */
  async function seed(deployment: Deployment): Promise<void> {
    const { host, trusted } = deployment

    for (const [id, status] of [
      ["t-open", "open"],
      ["t-closed", "closed"],
    ] as const) {
      await createTicket(deployment, { id, status })
      await trusted.objects.upsertLink(Ticket.id, id, "team", {
        targetTypeId: Team.id,
        targetId: "team-1",
      })
      await trusted
        .objects(Ticket)
        .byId(id)
        .telemetry(Ticket.p.temperature)
        .append({ value: 21, unit: "degreeCelsius", at: new Date(0) })
      await triggerRule(host, id)
    }

    await waitFor(
      () => host.events.read(),
      (events) => events.length === 11
    )
  }

  // Reproduce: in events/view-conditions.ts, drop the early return of visibleUnderConditions()
  // and the `conditions.has` filter of namedObjects(); the reader of every ticket reads the objects its
  // link, telemetry and rule events name.
  test("a reader without conditions reads no object to show events", async () => {
    const deployment = await deploy()
    await seed(deployment)
    const reads = countBatchReads()

    expect(await shown(deployment.sixbFor(["all"]))).toHaveLength(10)
    expect(reads).toEqual({ unscoped: [], conditional: [], logged: 0 })
  })

  // Reproduce: read each event's objects on its own in visibleUnderConditions(); the reader makes
  // one read per link, telemetry and rule event. The hidden ticket still exists, so it is checked
  // once and never looked up in the log.
  test("a reader with conditions reads the objects a batch names once", async () => {
    const deployment = await deploy()
    await seed(deployment)
    const reads = countBatchReads()

    expect(await shown(deployment.sixbFor(["open"]))).toEqual([
      "link.created t-open->team-1",
      "object.created t-open",
      "object.updated t-open",
      "rule.triggered t-open",
      "telemetry.appended t-open",
    ])
    expect(reads).toEqual({ unscoped: [1], conditional: [2], logged: 0 })
  })
})

describe("rules follow view conditions", () => {
  // Reproduce: drop the readerViewConditions() check from `visible` in rules/execution.ts.
  test("a rule on a conditioned type is listed", async () => {
    const { sixbFor } = await deploy()
    const reader = sixbFor(["open"])

    expect(reader.rules.list().map((rule) => rule.id)).toEqual([openTicket.id, watchedTeam.id])
    expect(reader.rules.getById(openTicket.id)?.id).toBe(openTicket.id)
    expect(sixbFor([]).rules.list()).toEqual([])
  })

  /** Three watched teams, and the open rule matching an open and a closed ticket. */
  async function seedMatches(deployment: Deployment): Promise<void> {
    const { host, trusted } = deployment

    for (const id of ["team-2", "team-3"]) {
      await trusted.objects(Team).upsert({ properties: { id } })
    }
    for (const id of ["team-1", "team-2", "team-3"]) {
      await triggerRule(host, id, watchedTeam)
    }

    await createTicket(deployment, { id: "t-open", status: "open" })
    await createTicket(deployment, { id: "t-closed", status: "closed" })
    await triggerRule(host, "t-open")
    await triggerRule(host, "t-closed")
  }

  const subjects = (result: Awaited<ReturnType<Reader["rules"]["states"]["list"]>>) =>
    result.states.map((state) => state.subject.primaryId).sort()

  // Reproduce: list the conditioned types too in rules/execution.ts (`objectTypeIds` from the
  // reader's conditions as well as its grants); the tickets' matches are listed and counted.
  test("a listing that names no object leaves out matches on a conditioned type", async () => {
    const deployment = await deploy()
    await seedMatches(deployment)
    const reader = deployment.sixbFor(["open"])

    const first = await reader.rules.states.list({ order: "asc", limit: 2 })
    expect(first).toMatchObject({ total: 3, hasMore: true })
    const rest = await reader.rules.states.list({ order: "asc", limit: 2, offset: 2 })
    expect(rest).toMatchObject({ total: 3, hasMore: false })
    expect([...subjects(first), ...subjects(rest)].sort()).toEqual(["team-1", "team-2", "team-3"])

    const tickets = await reader.rules.states.list({ objectTypeId: Ticket.id })
    expect(tickets).toEqual({ states: [], hasMore: false, total: 0 })

    // A role that views every ticket lists them all.
    const union = await deployment.sixbFor(["open", "all"]).rules.states.list()
    expect(union.total).toBe(5)
  })

  // Reproduce: drop the per-object branch from rules/execution.ts, and the open ticket's match is
  // not listed; list without reading the object, and the closed and missing tickets' are.
  test("a listing that names an object of a conditioned type lists its matches when it is visible", async () => {
    const deployment = await deploy()
    const { host, sixbFor } = deployment
    await seedMatches(deployment)
    await triggerRule(host, "t-missing")
    const reader = sixbFor(["open"])
    const ticket = (primaryId: string) => ({ objectTypeId: Ticket.id, primaryId })

    const open = await reader.rules.states.list(ticket("t-open"))
    expect(subjects(open)).toEqual(["t-open"])
    expect(open).toMatchObject({ total: 1, hasMore: false })

    const empty = { states: [], hasMore: false, total: 0 }
    expect(await reader.rules.states.list(ticket("t-closed"))).toEqual(empty)
    expect(await reader.rules.states.list(ticket("t-missing"))).toEqual(empty)

    expect(subjects(await sixbFor(["all"]).rules.states.list(ticket("t-closed")))).toEqual([
      "t-closed",
    ])
  })

  // Reproduce: drop the readerViewConditions() check from the per-object branch in
  // rules/execution.ts; the reader of every ticket reads the object it lists matches for.
  test("only a reader that views the object's type under a condition reads the object", async () => {
    const deployment = await deploy()
    await seedMatches(deployment)
    const reads = { unscoped: 0, conditional: 0 }
    const store = InMemoryObjectStorage.prototype

    const get = store.getByPrimaryId
    const unscoped = spyOn(store, "getByPrimaryId").mockImplementation(function (
      this: InMemoryObjectStorage,
      input
    ) {
      reads.unscoped += 1
      return get.call(this, input)
    })

    const conditional = store.createConditionalReadScope
    const scoped = spyOn(store, "createConditionalReadScope").mockImplementation(function (
      this: InMemoryObjectStorage,
      input
    ) {
      const storage = conditional.call(this, input)
      return {
        ...storage,
        getByPrimaryId: (read) => {
          reads.conditional += 1
          return storage.getByPrimaryId(read)
        },
      }
    })

    try {
      const ticket = { objectTypeId: Ticket.id, primaryId: "t-open" }
      await deployment.sixbFor(["all"]).rules.states.list(ticket)
      await deployment.sixbFor(["open"]).rules.states.list()
      expect(reads).toEqual({ unscoped: 0, conditional: 0 })

      await deployment.sixbFor(["open"]).rules.states.list(ticket)
      expect(reads).toEqual({ unscoped: 0, conditional: 1 })
    } finally {
      unscoped.mockRestore()
      scoped.mockRestore()
    }
  })
})

/** Mark `ticket.notes` as applied dataset versions do, for every reader created after this. */
function markAppliedNotes(host: SixbHost): void {
  const applied = getAppliedMarkings(host)
  const marked = {
    ...NO_APPLIED_MARKINGS,
    properties: new Map([[Ticket.id, new Map([["notes", new Set([restricted.id])]])]]),
    markings: new Set([restricted.id]),
  }

  spyOn(applied, "affects").mockReturnValue(true)
  spyOn(applied, "current").mockResolvedValue(marked)
  spyOn(applied, "forEarlierValues").mockImplementation((snapshot) => snapshot)
}

/** Count the object batch reads of a conditional reader, by the number of objects each reads. */
function countingBatches(storage: ObjectReadStorage, reads: number[]): ObjectReadStorage {
  return {
    ...storage,
    getByPrimaryIdBatch: (input) => {
      reads.push(input.items.length)
      return storage.getByPrimaryIdBatch(input)
    },
  }
}
