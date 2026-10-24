import { describe, expect, test } from "bun:test"
import {
  type AuthorizationContext,
  can,
  currentUser,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  prop,
  ref,
  SixbHost,
  userRef,
} from "../src"
import { createTestSixb } from "../src/testing"
import { resolveRolesWithConditions } from "./helpers/view-conditions"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// Tickets carry telemetry and action runs. Staff read the open ones through a condition, owners
// their own; roles here hold conditional view grants, which a host still refuses at startup, so
// contexts are resolved beside the host.

const projectId = "view-condition-telemetry-and-runs"
const filterable = { query: { searchable: true, filterable: true } } as const

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
    prop("temperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
  ],
})

const escalate = defineAction("escalate-ticket")
  .on(Ticket)
  .params({})
  .edits(() => {})

const renameTeam = defineAction("rename-team")
  .on(Team)
  .params({})
  .edits(() => {})

const announce = defineAction("announce")
  .params({})
  .edits(() => {})

const isOpen = can.view(Ticket).where((ticket) => ticket.p.status.eq("open"))
const isMine = can.view(Ticket).where((ticket) => ticket.p.owner.eq(currentUser()))
const applyAll = [can.apply(escalate), can.apply(renameTeam), can.apply(announce)]

const roles = [
  defineRole("open-tickets", {
    grantedTo: [defineGroup("open")],
    grants: [isOpen, can.view(Team), ...applyAll],
  }),
  defineRole("my-tickets", { grantedTo: [defineGroup("mine")], grants: [isMine, ...applyAll] }),
  defineRole("all-tickets", {
    grantedTo: [defineGroup("all")],
    grants: [can.view(Ticket), can.view(Team), ...applyAll],
  }),
  defineRole("open-watchers", { grantedTo: [defineGroup("watch")], grants: [isOpen] }),
  defineRole("ticket-sensors", {
    grantedTo: [defineGroup("sensors")],
    grants: [isOpen, can.append(Ticket)],
  }),
]

const alice = { type: "user", id: "usr_alice" } as const
const bob = { type: "user", id: "usr_bob" } as const
const reports = { type: "serviceAccount", id: "svc_reports" } as const

const tickets = [
  { id: "t-open-alice", status: "open", owner: userRef("usr_alice") },
  { id: "t-open-bob", status: "open", owner: userRef("usr_bob") },
  { id: "t-closed-alice", status: "closed", owner: userRef("usr_alice") },
  { id: "t-closed-bob", status: "closed", owner: userRef("usr_bob") },
  { id: "t-gone", status: "open", owner: userRef("usr_alice") },
] as const

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute))

async function deploy() {
  const host = new SixbHost({
    id: projectId,
    ontology: [Team, Ticket],
    actions: [escalate, renameTeam, announce],
    ...createTestRuntimeDeps(),
  })
  const trusted = createTestSixb(host)

  for (const id of ["usr_alice", "usr_bob"]) {
    await host.storage.auth?.users.create({ projectId, id, email: `${id}@example.com` })
  }

  await trusted.objects(Team).upsert({ properties: { id: "team-1" } })

  for (const [index, properties] of tickets.entries()) {
    await trusted.objects(Ticket).upsert({ properties })
    await trusted
      .objects(Ticket)
      .byId(properties.id)
      .telemetry(Ticket.p.temperature)
      .append({ value: 20 + index, unit: "degreeCelsius", at: at(index) })
  }

  const { contextFor } = resolveRolesWithConditions({ ontology: [Team, Ticket], roles })

  const sixbFor = (
    groupIds: readonly string[],
    principal: AuthorizationContext["principal"] = alice
  ) => createTestSixb(host, { authorization: contextFor(groupIds, principal) })

  const deleteGone = () => trusted.objects(Ticket).byId("t-gone").delete()

  return { host, trusted, contextFor, sixbFor, deleteGone }
}

type Sixb = ReturnType<Awaited<ReturnType<typeof deploy>>["sixbFor"]>

const series = (objectId: string) => ({
  objectTypeId: Ticket.id,
  objectId,
  propertyId: "temperature",
})

/** The tickets whose latest temperature a reader gets. */
async function ticketsWithTelemetry(sixb: Sixb): Promise<readonly string[]> {
  const latest = await Promise.all(
    tickets.map((ticket) => sixb.objects.getLatestTelemetry(series(ticket.id)))
  )
  return tickets.flatMap((ticket, index) => (latest[index] ? [ticket.id] : []))
}

describe("telemetry reads through view conditions", () => {
  // Reproduce: in the reader's #selectsObjectProperties, select every property of a conditioned
  // type as of a type viewed whole; the closed tickets' telemetry is read.
  test("an object's telemetry reads while its condition shows the object", async () => {
    const { sixbFor } = await deploy()
    const staff = sixbFor(["open"])

    expect(await staff.objects.getLatestTelemetry(series("t-open-alice"))).toMatchObject({
      objectId: "t-open-alice",
      value: 20,
    })
    expect(await staff.objects.getLatestTelemetry(series("t-closed-bob"))).toBeNull()

    expect(await staff.objects.getTelemetryHistory(series("t-open-bob"))).toHaveLength(1)
    expect(await staff.objects.getTelemetryHistory(series("t-closed-alice"))).toEqual([])

    const channel = (id: string) => staff.objects(Ticket).byId(id).telemetry(Ticket.p.temperature)
    expect(await channel("t-open-alice").history()).toEqual([
      { value: 20, unit: "degreeCelsius", at: at(0) },
    ])
    expect(await channel("t-closed-alice").history()).toEqual([])
  })

  test("a batch reads each series by its own object, hidden and missing alike", async () => {
    const { sixbFor, deleteGone } = await deploy()
    await deleteGone()

    const history = await sixbFor(["open"]).objects.getTelemetryHistoryBatch({
      series: ["t-closed-bob", "t-open-alice", "t-gone", "t-never", "t-open-bob"].map(series),
    })

    expect(history.map((entry) => [entry.objectId, entry.points.length])).toEqual([
      ["t-closed-bob", 0],
      ["t-open-alice", 1],
      ["t-gone", 0],
      ["t-never", 0],
      ["t-open-bob", 1],
    ])

    // A reader of every ticket still reads the deleted ticket's telemetry, as before.
    expect(await sixbFor(["all"]).objects.getLatestTelemetry(series("t-gone"))).not.toBeNull()
  })

  test("a reader reads the telemetry of the union of its grants", async () => {
    const { sixbFor } = await deploy()

    expect(await ticketsWithTelemetry(sixbFor(["open", "mine"]))).toEqual([
      "t-open-alice",
      "t-open-bob",
      "t-closed-alice",
      "t-gone",
    ])
    expect(await ticketsWithTelemetry(sixbFor(["open", "all"]))).toHaveLength(tickets.length)
  })

  test("currentUser() in a condition stands for the user reading telemetry", async () => {
    const { sixbFor } = await deploy()

    expect(await ticketsWithTelemetry(sixbFor(["mine"], alice))).toEqual([
      "t-open-alice",
      "t-closed-alice",
      "t-gone",
    ])
    expect(await ticketsWithTelemetry(sixbFor(["mine"], bob))).toEqual([
      "t-open-bob",
      "t-closed-bob",
    ])
    expect(await ticketsWithTelemetry(sixbFor(["mine"], reports))).toEqual([])
  })

  // Appending answers with no object state: its own grant decides, and a condition adds nothing.
  test("appends keep their own grant", async () => {
    const { sixbFor } = await deploy()
    const sensors = sixbFor(["sensors"])

    await sensors
      .objects(Ticket)
      .byId("t-closed-bob")
      .telemetry(Ticket.p.temperature)
      .append({ value: 30, unit: "degreeCelsius", at: at(10) })

    expect(await sixbFor(["all"]).objects.getTelemetryHistory(series("t-closed-bob"))).toHaveLength(
      2
    )
    expect(await sensors.objects.getTelemetryHistory(series("t-closed-bob"))).toEqual([])
  })
})
