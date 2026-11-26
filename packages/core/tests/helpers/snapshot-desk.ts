import {
  type AuthorizationContext,
  can,
  col,
  currentUser,
  defineDataset,
  defineGroup,
  defineMarking,
  defineObjectType,
  defineProjection,
  defineRole,
  type EmbeddingModel,
  link,
  project,
  prop,
  ref,
  resolveAuthorizationContext,
  SixbHost,
  userRef,
} from "../../src"
import { createTestingScope } from "../../src/execution/scopes"
import { decodeSnapshot } from "../../src/snapshots/format"
import { createTestSixb } from "../../src/testing"
import { createTestRuntimeDeps } from "../test-runtime-deps"
import { groupsOf } from "./view-conditions"

// A support desk: teams and tickets. Agents read the open tickets only, without the
// confidential notes; managers read everything and the members.

export const projectId = "snapshots"
export const confidential = defineMarking("confidential")

export const names: EmbeddingModel = {
  providerId: "test",
  modelId: "snapshot-tickets",
  definition: { kind: "embedding", providerId: "test", modelId: "snapshot-tickets", dimensions: 2 },
  async embed({ texts }) {
    return { vectors: texts.map((text) => [text.length, 1]) }
  },
}

export const Team = defineObjectType({
  id: "team",
  name: "Team",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
  links: [link.ref("escalations", "ticket")],
})

export const Ticket = defineObjectType({
  id: "ticket",
  name: "Ticket",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string", { query: { searchable: true, filterable: true } }),
    prop("owner", ref.user(), { nullable: true, query: { searchable: true, filterable: true } }),
    prop("title", "string"),
    prop("notes", "string", { markings: [confidential] }),
    prop("code", "string", { unique: true, markings: [confidential] }),
  ],
  links: [link("team", Team, { cardinality: "one" })],
  search: {
    vectors: {
      titles: { source: ["title"], model: names },
      notes: { source: ["notes"], model: names },
    },
  },
})

export const Invoice = defineObjectType({
  id: "invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
})

// Invoices come from the books: a projection feeds them.
export const books = defineDataset("snapshot_books", { schema: [col("id", "string")] })
export const invoicesFromBooks = defineProjection("snapshot_invoices", Invoice)
  .fromDataset(books)
  .properties({ id: "id" })

export const roles = [
  defineRole("agents", {
    grantedTo: [defineGroup("agents")],
    grants: [
      can.view(Ticket).where((ticket) => ticket.p.status.eq("open")),
      can.view(Ticket).where((ticket) => ticket.p.owner.eq(currentUser())),
      can.view(Team),
    ],
  }),
  defineRole("managers", {
    grantedTo: [defineGroup("managers")],
    grants: [can.view([Ticket, Team, Invoice]), can.view(project.users), can.view(books)],
    clearances: [confidential],
  }),
]

export const alice: AuthorizationContext["principal"] = { type: "user", id: "usr_alice" }

export async function deploy() {
  const host = new SixbHost({
    id: projectId,
    ontology: [Team, Ticket, Invoice],
    datasets: [books],
    projections: [invoicesFromBooks],
    markings: [confidential],
    groups: groupsOf(roles),
    roles,
    models: { embedding: [names] },
    ...createTestRuntimeDeps(),
  })
  const trusted = createTestSixb(host)

  for (const id of ["usr_alice", "usr_bob"]) {
    await host.storage.auth?.users.create({ projectId, id, email: `${id}@example.com` })
  }
  await host.storage.auth?.groupMemberships.upsert({
    projectId,
    userId: "usr_alice",
    groupId: "agents",
    source: "manual",
  })
  await host.storage.auth?.groupMemberships.upsert({
    projectId,
    userId: "usr_bob",
    groupId: "managers",
    source: "manual",
  })

  await trusted.objects(Team).upsert({ properties: { id: "team-1", name: "Support" } })
  await trusted.objects(Invoice).upsert({ properties: { id: "inv-1" } })

  const tickets = [
    { id: "t-open", status: "open", owner: null, title: "Printer jam" },
    { id: "t-mine", status: "closed", owner: userRef("usr_alice"), title: "Laptop" },
    { id: "t-hidden", status: "closed", owner: userRef("usr_bob"), title: "Payroll leak" },
  ] as const
  for (const ticket of tickets) {
    await trusted.objects(Ticket).upsert({
      properties: {
        ...ticket,
        notes: `secret-note-${ticket.id}`,
        code: `secret-code-${ticket.id}`,
      },
    })
    await trusted.objects(Ticket).byId(ticket.id).link(Ticket.l.team, {
      objectTypeId: Team.id,
      primaryId: "team-1",
    })
    await trusted.objects(Ticket).byId(ticket.id).vector("titles").index()
    await trusted.objects(Ticket).byId(ticket.id).vector("notes").index()
    await trusted.objects(Team).byId("team-1").link(Team.l.escalations, {
      objectTypeId: Ticket.id,
      primaryId: ticket.id,
    })
  }

  const optionsFor = (groupIds: readonly string[], principal = alice) => ({
    scope: createTestingScope({
      projectId,
      context: resolveAuthorizationContext({
        principal,
        groupIds,
        roles: host.definitions.security.listResolvedRoles(),
      }),
    }),
  })

  return { host, trusted, optionsFor }
}

/** Every record of a snapshot, and its decoded text: what leaves production. */
export async function readAll(snapshot: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = []
  for await (const chunk of snapshot) chunks.push(chunk)

  const records = []
  for await (const record of decodeSnapshot(chunks)) records.push(record)
  return { chunks, records, text: JSON.stringify(records) }
}
