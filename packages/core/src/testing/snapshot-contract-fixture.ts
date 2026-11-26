import {
  can,
  defineGroup,
  defineMarking,
  defineObjectType,
  defineRole,
  type EmbeddingModel,
  link,
  OntologyRegistry,
  project,
  prop,
  ref,
  resolveAuthorizationContext,
  SixbHost,
} from ".."
import { InMemoryBlobStorage } from "../blob-storage"
import { InMemoryBroker } from "../broker"
import { createTestingScope } from "../execution/scopes"
import { InMemoryLakeStorage } from "../lake-storage"
import { InMemoryQueues } from "../queues"
import { decodeSnapshot, type SnapshotRecord } from "../snapshots/format"
import { migrateStorage } from "../storage/migrations"
import type { Storage } from "../storage/types"
import { createTestSixb } from "./execution"
import { createStoredArtifact } from "./stored-artifacts"

// Two customers and three invoices, linked both ways, with telemetry, vectors and members. Alice
// owns the project. Bob is a clerk: he reads open invoices only, without their memo, and no
// member but himself.

export const PROJECT = "snapshot-contract"
/** A SQL provider creates schemas and builds indexes for each case. */
export const TIMEOUT_MS = 30_000
const AT = Date.parse("2026-01-01T00:00:00.000Z")

/** Tells Grace from everyone else, so each vector is recognisable after a round trip. */
const embedding: EmbeddingModel = {
  providerId: "test",
  modelId: "snapshot-names",
  definition: { kind: "embedding", providerId: "test", modelId: "snapshot-names", dimensions: 3 },
  async embed({ texts }) {
    return { vectors: texts.map((text) => (text.includes("Grace") ? [0, 1, 0] : [1, 0, 0])) }
  },
}

const internal = defineMarking("snapshot-internal")

export const Customer = defineObjectType({
  id: "SnapshotCustomer",
  name: "Customer",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("name", "string"),
    prop("email", "string", { unique: true }),
    prop("contract", ref.artifact(), { nullable: true }),
  ],
  links: [link.ref("invoices", "SnapshotInvoice")],
  search: { vectors: { names: { source: ["name"], model: embedding } } },
})

export const Invoice = defineObjectType({
  id: "SnapshotInvoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("amount", "double"),
    prop("status", "string", { query: { searchable: true, filterable: true } }),
    prop("memo", "string", { markings: [internal] }),
    prop("temperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
  ],
  links: [link("customer", Customer, { cardinality: "one" })],
})

const roles = [
  defineRole("snapshot-owner", {
    grantedTo: [defineGroup("owners")],
    grants: [can.view([Customer, Invoice]), can.edit([Customer, Invoice]), can.view(project.users)],
    clearances: [internal],
  }),
  defineRole("snapshot-clerk", {
    grantedTo: [defineGroup("clerks")],
    grants: [can.view(Customer), can.view(Invoice).where((invoice) => invoice.p.status.eq("open"))],
  }),
]

export function ontology(): OntologyRegistry {
  return new OntologyRegistry({ sources: [Customer, Invoice] })
}

export function createHost(storage: Storage): SixbHost {
  return new SixbHost({
    id: PROJECT,
    ontology: [Customer, Invoice],
    markings: [internal],
    groups: [defineGroup("owners"), defineGroup("clerks")],
    roles,
    models: { embedding: [embedding] },
    blobStorage: new InMemoryBlobStorage(),
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    queues: new InMemoryQueues(),
    storage,
  })
}

/** Alice's export: everything. One object per page, so every type spans pages. */
export function ownerOptions(host: SixbHost) {
  return optionsFor(host, "usr_alice", "owners")
}

/** Bob's export: open invoices without their memo, and himself as the only member. */
export function clerkOptions(host: SixbHost) {
  return optionsFor(host, "usr_bob", "clerks")
}

function optionsFor(host: SixbHost, userId: string, group: string) {
  const context = resolveAuthorizationContext({
    principal: { type: "user", id: userId },
    groupIds: [group],
    roles: host.definitions.security.listResolvedRoles(),
  })
  return {
    scope: createTestingScope({ projectId: PROJECT, context }),
    concurrency: 2,
    pageSize: 1,
  }
}

/** Every record of a snapshot, its bytes, and their decoded text: what leaves production. */
export async function readSnapshot(snapshot: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = []
  for await (const chunk of snapshot) chunks.push(chunk)

  const records: SnapshotRecord[] = []
  for await (const record of decodeSnapshot(chunks)) records.push(record)
  return { chunks, records, text: JSON.stringify(records) }
}

export async function seededHost(storage: Storage): Promise<SixbHost> {
  await migrateStorage(storage, { projectId: PROJECT, ontology: ontology() })
  const host = createHost(storage)
  const trusted = createTestSixb(host)

  const at = (offset: number) => new Date(AT + offset * 1_000)
  await createStoredArtifact(storage, { projectId: PROJECT, id: "art_k3m9q2x7tp" })
  for (const [id, name] of [
    ["c1", "Ada"],
    ["c2", "Grace"],
  ] as const) {
    await trusted
      .objects(Customer)
      .upsert({ properties: { id, name, email: `${name.toLowerCase()}@example.com` } })
    await trusted.objects(Customer).byId(id).vector("names").index()
  }
  await trusted.objects(Customer).upsert({
    properties: { id: "c1", contract: { type: "artifact", id: "art_k3m9q2x7tp" } },
  })

  for (const [id, amount, status, customer] of [
    ["i1", 10, "open", "c1"],
    ["i2", 20, "paid", "c1"],
    ["i3", 30, "open", "c2"],
  ] as const) {
    await trusted
      .objects(Invoice)
      .upsert({ properties: { id, amount, status, memo: `memo-secret-${id}` } })
    await trusted.objects(Invoice).byId(id).link(Invoice.l.customer, {
      objectTypeId: Customer.id,
      primaryId: customer,
    })
    for (const [offset, value] of [
      [0, amount],
      [60, amount / 10 + 20],
    ] as const) {
      await trusted
        .objects(Invoice)
        .byId(id)
        .telemetry(Invoice.p.temperature)
        .append({ value, unit: "degreeCelsius", at: at(offset) })
    }
  }

  for (const id of ["i1", "i2"]) {
    await trusted.objects(Customer).byId("c1").link(Customer.l.invoices, {
      objectTypeId: Invoice.id,
      primaryId: id,
    })
  }

  for (const [id, group] of [
    ["usr_alice", "owners"],
    ["usr_bob", "clerks"],
  ] as const) {
    await storage.auth?.users.create({ projectId: PROJECT, id, email: `${id}@example.com` })
    await storage.auth?.groupMemberships.upsert({
      projectId: PROJECT,
      userId: id,
      groupId: group,
      source: "manual",
    })
  }

  return host
}
