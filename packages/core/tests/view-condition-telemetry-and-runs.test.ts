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
import type { ActionSubject } from "../src/actions"
import { canViewProjection, canViewProjectionRun } from "../src/authorization"
import type { ObjectProjectionDefinition } from "../src/projections"
import { decorateOperationScopedMethodForTesting } from "../src/storage/operation-scope"
import { createTestSixb, recordTestActionRun } from "../src/testing"
import { contextIn, groupsOf } from "./helpers/view-conditions"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// Tickets carry telemetry and action runs. Staff read the open ones through a condition, owners
// their own.

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
    groups: groupsOf(roles),
    roles,
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

  const contextFor = (
    groupIds: readonly string[],
    principal: AuthorizationContext["principal"] = alice
  ) => contextIn(host, groupIds, principal)

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

/** Record a finished run on a subject, started at a fixed minute. */
async function recordRun(
  host: SixbHost,
  run: { readonly id: string; readonly actionId: string; readonly minute: number },
  subject: ActionSubject
) {
  await recordTestActionRun(host.storage, {
    id: run.id,
    projectId,
    actionId: run.actionId,
    subject,
    params: {},
    idempotencyKey: run.id,
    startedAt: at(run.minute),
  })
}

const ticketSubject = (primaryId: string): ActionSubject => ({
  kind: "object",
  objectTypeId: Ticket.id,
  primaryId,
})

/**
 * Two runs per ticket, then two on the team and one global run, interleaved in time so that hidden
 * runs fall between visible ones. Listings are newest first: the run ids below are oldest first.
 */
async function recordRuns(host: SixbHost): Promise<readonly string[]> {
  const ids: string[] = []
  let minute = 0

  for (const round of [1, 2]) {
    for (const ticket of tickets) {
      const id = `run-${round}-${ticket.id}`
      await recordRun(
        host,
        { id, actionId: escalate.id, minute: minute++ },
        ticketSubject(ticket.id)
      )
      ids.push(id)
    }

    const teamRun = `run-${round}-team`
    await recordRun(
      host,
      { id: teamRun, actionId: renameTeam.id, minute: minute++ },
      { kind: "object", objectTypeId: Team.id, primaryId: "team-1" }
    )
    ids.push(teamRun)
  }

  await recordRun(
    host,
    { id: "run-announce", actionId: announce.id, minute: minute++ },
    {
      kind: "none",
    }
  )
  ids.push("run-announce")

  return ids
}

/** Every run a listing returns, page by page, with each page's total and hasMore. */
async function listInPages(sixb: Sixb, limit: number, filter: { subject?: ActionSubject } = {}) {
  const pages: { runs: readonly string[]; total: number; hasMore: boolean }[] = []

  for (let offset = 0; ; offset += limit) {
    const page = await sixb.actions.runs.list({ ...filter, limit, offset })
    pages.push({ runs: page.runs.map((run) => run.id), total: page.total, hasMore: page.hasMore })
    if (!page.hasMore) return pages
  }
}

const noRuns = { runs: [], hasMore: false, total: 0 }

describe("action runs through view conditions", () => {
  // Reproduce: return canViewActionRun alone from viewableActionRuns; every run on a ticket is
  // hidden from staff, the open ones included.
  test("a run reads while its subject does", async () => {
    const { host, sixbFor, deleteGone } = await deploy()
    await recordRuns(host)
    await deleteGone()

    const staff = sixbFor(["open"])
    expect(await staff.actions.runs.getById("run-1-t-open-alice")).toMatchObject({
      id: "run-1-t-open-alice",
    })
    expect(await staff.actions.runs.getById("run-1-t-closed-bob")).toBeNull()
    expect(await staff.actions.runs.getById("run-1-team")).not.toBeNull()
    expect(await staff.actions.runs.getById("run-announce")).not.toBeNull()

    // A deleted subject shows nothing, so its runs stay hidden. A grant on the whole type still
    // reads them.
    expect(await staff.actions.runs.getById("run-1-t-gone")).toBeNull()
    expect(await sixbFor(["all"]).actions.runs.getById("run-1-t-gone")).not.toBeNull()

    // The condition opens the subject, not the action.
    expect(await sixbFor(["watch"]).actions.runs.getById("run-1-t-open-alice")).toBeNull()
  })

  // Reproduce: list with the conditioned types among objectTypeIds; the closed tickets' runs are
  // listed and counted.
  test("a listing without a subject leaves out a type viewed through a condition", async () => {
    const { host, sixbFor } = await deploy()
    await recordRuns(host)
    const staff = sixbFor(["open"])

    expect(await listInPages(staff, 2)).toEqual([
      { runs: ["run-announce", "run-2-team"], total: 3, hasMore: true },
      { runs: ["run-1-team"], total: 3, hasMore: false },
    ])
    expect(await staff.actions.runs.list({ objectTypeId: Ticket.id })).toEqual(noRuns)
  })

  // Reproduce: drop the readableSubjects check from runs.list; a hidden ticket's runs are listed.
  test("a listing by subject shows its runs while the reader sees the subject", async () => {
    const { host, sixbFor, deleteGone } = await deploy()
    await recordRuns(host)
    await deleteGone()
    const staff = sixbFor(["open"])

    expect(await listInPages(staff, 1, { subject: ticketSubject("t-open-alice") })).toEqual([
      { runs: ["run-2-t-open-alice"], total: 2, hasMore: true },
      { runs: ["run-1-t-open-alice"], total: 2, hasMore: false },
    ])

    expect(await staff.actions.runs.list({ subject: ticketSubject("t-closed-bob") })).toEqual(
      noRuns
    )
    expect(await staff.actions.runs.list({ subject: ticketSubject("t-gone") })).toEqual(noRuns)

    // objectTypeId and primaryId name a subject too, as the HTTP listing does.
    const byId = (primaryId: string) =>
      staff.actions.runs.list({ objectTypeId: Ticket.id, primaryId })
    expect((await byId("t-open-alice")).total).toBe(2)
    expect(await byId("t-closed-bob")).toEqual(noRuns)

    // The condition opens the subject, not the action.
    const watcher = sixbFor(["watch"])
    expect(await watcher.actions.runs.list({ subject: ticketSubject("t-open-alice") })).toEqual(
      noRuns
    )
  })

  test("a listing shows the runs of the union of the reader's grants", async () => {
    const { host, sixbFor } = await deploy()
    const recorded = await recordRuns(host)

    const listed = await sixbFor(["open", "all"]).actions.runs.list()
    expect(listed.runs.map((run) => run.id)).toEqual([...recorded].reverse())
    expect(listed.total).toBe(recorded.length)

    // Either condition shows the subject.
    const closedAlice = { subject: ticketSubject("t-closed-alice") }
    expect((await sixbFor(["open", "mine"], alice).actions.runs.list(closedAlice)).total).toBe(2)
    expect((await sixbFor(["open"], alice).actions.runs.list(closedAlice)).total).toBe(0)
  })

  test("currentUser() in a condition stands for the user listing a subject's runs", async () => {
    const { host, sixbFor } = await deploy()
    await recordRuns(host)
    const closedAlice = { subject: ticketSubject("t-closed-alice") }

    expect((await sixbFor(["mine"], alice).actions.runs.list(closedAlice)).total).toBe(2)
    expect(await sixbFor(["mine"], bob).actions.runs.list(closedAlice)).toEqual(noRuns)
    expect(await sixbFor(["mine"], reports).actions.runs.list(closedAlice)).toEqual(noRuns)
  })

  // Reproduce: read the subject of every subject-filtered listing, conditioned or not; the reader
  // of every ticket reads it.
  test("a reader of the whole type lists a subject's runs without reading the subject", async () => {
    const { host, sixbFor } = await deploy()
    await recordRuns(host)
    const reads: string[] = []
    decorateOperationScopedMethodForTesting(host.storage.objects, "getByPrimaryIdBatch", (read) => {
      return async (input) => {
        reads.push(...input.items.map((item) => item.primaryId))
        return read(input)
      }
    })

    const subject = { subject: ticketSubject("t-closed-bob") }
    expect((await sixbFor(["all"]).actions.runs.list(subject)).total).toBe(2)
    expect(reads).toEqual([])
  })
})

// A projection run, like its definition, describes every object of its type.
test("projections stay closed to a type viewed through a condition", async () => {
  const { contextFor } = await deploy()
  const projection: ObjectProjectionDefinition = {
    _tag: "ObjectProjectionDefinition",
    id: "tickets",
    objectTypeId: Ticket.id,
    datasetId: "tickets",
    properties: {},
    links: {},
  }

  expect(canViewProjection(contextFor(["open"]), projection)).toBe(false)
  expect(canViewProjectionRun(contextFor(["open"]), { objectTypeId: Ticket.id })).toBe(false)
  expect(canViewProjectionRun(contextFor(["open", "all"]), { objectTypeId: Ticket.id })).toBe(true)
})
