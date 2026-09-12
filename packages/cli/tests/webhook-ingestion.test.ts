import { expect, test } from "bun:test"
import {
  change,
  col,
  defineConnector,
  defineDataset,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineProjection,
  defineSchedule,
  defineSync,
  defineWebhook,
  events,
  fromForeignKey,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  link,
  prop,
  SixbHost,
} from "@sixb/core"
import { writeDataset } from "@sixb/core/internal/datasets"
import { createTestSixb } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../../server/src/server"
import { startSixbRuntime } from "../src/lib/runtime"

interface PersonRow {
  id: string
  revision: number
  email: string
  name: string
  phone: string | null
  org: string | null
}
const schema = [
  col("id", "string"),
  col("revision", "int64"),
  col("email", "string"),
  col("name", "string"),
  col("phone", "string", { nullable: true }),
  col("org", "string", { nullable: true }),
]
const pipedrive = defineDataset("source.pipedrive", {
  schema,
  primaryKey: "id",
  sequenceBy: "revision",
})
const pandadoc = defineDataset("source.pandadoc", {
  schema,
  primaryKey: "id",
  sequenceBy: "revision",
})
const contacts = defineDataset("merged.contacts", {
  schema: schema.filter((column) => column.name !== "revision"),
})
const Organization = defineObjectType({
  id: "Organization",
  name: "Organization",
  properties: [prop("id", "string", { primary: true, required: true })],
})
const Contact = defineObjectType({
  id: "Contact",
  name: "Contact",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("email", "string"),
    prop("name", "string"),
    prop("phone", "string"),
  ],
  links: [link("organization", Organization, { cardinality: "one" })],
})
const projection = defineProjection("contacts", Contact)
  .fromDataset(contacts)
  .properties({ id: "id", email: "email", name: "name", phone: "phone" })
  .withLinks({
    organization: fromForeignKey({
      link: Contact.l.organization,
      sourceField: "org",
      target: Organization,
    }),
  })

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const value = await read()
    if (ready(value)) return value
    await Bun.sleep(10)
  }
  throw new Error("Timed out waiting for ingestion downstream work")
}

test("verified webhooks and snapshots feed merged contacts through orchestration and projections", async () => {
  // Regression proof: remove ingest's dataset.version.committed emission; the contact wait times out.
  let failPipeline = false
  let handled = 0
  let snapshotRows: PersonRow[] = []
  const toRow = (person: PersonRow) => ({ ...person, email: person.email.trim().toLowerCase() })
  const connector = defineConnector("crm", {
    type: "test",
    connect: () => ({}),
    webhooks: [
      defineWebhook("person")
        .post()
        .json({
          parse(value: unknown) {
            if (
              typeof value !== "object" ||
              value === null ||
              !("source" in value) ||
              !("person" in value)
            )
              throw new Error("invalid person event")
            if (value.source !== "pipedrive" && value.source !== "pandadoc")
              throw new Error("invalid source")
            const person = value.person
            if (
              typeof person !== "object" ||
              person === null ||
              !("id" in person) ||
              typeof person.id !== "string" ||
              !("revision" in person) ||
              typeof person.revision !== "number" ||
              !("email" in person) ||
              typeof person.email !== "string" ||
              !("name" in person) ||
              typeof person.name !== "string" ||
              !("phone" in person) ||
              (person.phone !== null && typeof person.phone !== "string") ||
              !("org" in person) ||
              (person.org !== null && typeof person.org !== "string")
            )
              throw new Error("invalid person")
            return {
              source: value.source,
              person: {
                id: person.id,
                revision: person.revision,
                email: person.email,
                name: person.name,
                phone: person.phone,
                org: person.org,
              },
            }
          },
        })
        .verify(({ request }) => {
          if (request.headers.get("x-secret") !== "test-secret")
            throw new Error("invalid signature")
        })
        .idempotencyKey(({ request }) => request.headers.get("x-delivery"))
        .handle(async ({ sixb, body }) => {
          handled += 1
          const result = await sixb.datasets.ingest(
            body.source === "pipedrive" ? pipedrive : pandadoc,
            { changes: [change.upsert(toRow(body.person))] }
          )
          return { status: 200, body: { outcome: result.outcome } }
        }),
    ],
  })
  const sync = defineSync("pipedrive-snapshot")
    .from(connector)
    .read(() => snapshotRows.map(toRow))
    .intoDataset(pipedrive)
  const pdUpdated = defineSchedule("pipedrive-updated").on(events.dataset(pipedrive).updated())
  const docUpdated = defineSchedule("pandadoc-updated").on(events.dataset(pandadoc).updated())
  const merge = definePipelineStep("merge-contacts")
    .inputs({ pipedrive, pandadoc })
    .output(contacts)
    .run(async ({ inputs, output }) => {
      if (failPipeline) throw new Error("contact pipeline unavailable")
      const groups = new Map<string, Record<string, unknown>>()
      // Fallback first, preferred source second. Recompute the complete view, including old email groups.
      for (const source of [inputs.pandadoc, inputs.pipedrive])
        for await (const row of source.readRows()) {
          const email = String(row.email)
          const prior = groups.get(email)
          groups.set(email, {
            id: email,
            email,
            name: row.name,
            phone: row.phone ?? prior?.phone ?? null,
            org: row.org ?? prior?.org ?? null,
          })
        }
      await output.writeRows(groups.values())
    })
  const pipeline = definePipeline("contacts").when(pdUpdated).when(docUpdated).then(merge)
  const lakeStorage = new InMemoryLakeStorage()
  // A first empty snapshot is a real pipeline input; no fake source rows or deletions are needed.
  // Regression proof: remove createInitialVersion from the writer; the first contact never appears.
  for (const dataset of [pipedrive, pandadoc]) {
    await writeDataset({
      lakeStorage,
      blobStorage: new InMemoryBlobStorage(),
      dataset,
      mode: "snapshot",
      signal: new AbortController().signal,
      readValues: async () => [],
    })
  }
  const host = new SixbHost({
    id: "webhook-ingestion",
    ontology: [Contact, Organization],
    datasets: [pipedrive, pandadoc, contacts],
    connectors: [connector],
    syncs: [sync],
    schedules: [pdUpdated, docUpdated],
    pipelines: [pipeline],
    projections: [projection],
    lakeStorage,
    storage: new InMemoryStorage(),
    queues: new InMemoryQueues(),
    broker: new InMemoryBroker(),
    blobStorage: new InMemoryBlobStorage(),
    onError: () => {},
  })
  const sixb = createTestSixb(host)
  const app = createSixbApi(
    new SixbServer({
      host,
      browser: {
        publicOrigin: "http://localhost",
        allowedOrigins: [{ origin: "http://localhost", audience: "atlas" }],
      },
    })
  )
  const runtime = await startSixbRuntime(host, { cohostWorkers: true })
  const person: PersonRow = {
    id: "42",
    revision: 8,
    email: " Sam@Example.com ",
    name: "Preferred",
    phone: null,
    org: "org-1",
  }
  const send = (source: string, person: PersonRow, delivery: string, secret = "test-secret") =>
    app.fetch(
      new Request("http://localhost/api/webhooks/crm/person", {
        method: "POST",
        headers: { "content-type": "application/json", "x-secret": secret, "x-delivery": delivery },
        body: JSON.stringify({ source, person }),
      })
    )
  const contact = (id = "sam@example.com") => sixb.objects(Contact).get(id)
  try {
    await sixb.objects(Organization).upsert({ properties: { id: "org-1" } })
    await sixb.objects(Organization).upsert({ properties: { id: "org-2" } })
    expect((await send("pipedrive", person, "invalid", "wrong")).status).not.toBe(200)
    expect(handled).toBe(0)
    expect(
      (
        await send(
          "pandadoc",
          { ...person, id: "9", revision: 1, name: "Fallback", phone: "555", org: null },
          "doc-1"
        )
      ).status
    ).toBe(200)
    await waitFor(contact, (value) => value?.properties.name === "Fallback")
    expect((await send("pipedrive", person, "pd-1")).status).toBe(200)
    const merged = await waitFor(contact, (value) => value?.properties.name === "Preferred")
    expect(merged?.properties.phone).toBe("555")
    expect((await send("pipedrive", person, "pd-1")).status).toBe(202)
    expect(handled).toBe(2)

    snapshotRows = [{ ...person, revision: 7, name: "Stale snapshot" }]
    const syncRun = await sixb.syncs.request({ syncId: sync.id })
    await waitFor(
      () => host.storage.syncRuns!.getById({ projectId: host.id, id: syncRun.runId }),
      (run) => run?.status === "succeeded"
    )
    expect((await contact())?.properties.name).toBe("Preferred")

    expect(
      (
        await send(
          "pipedrive",
          { ...person, revision: 9, email: "new@example.com", org: "org-2" },
          "pd-2"
        )
      ).status
    ).toBe(200)
    await waitFor(
      () => contact("new@example.com"),
      (value) => value?.properties.name === "Preferred"
    )
    expect((await contact())?.properties).toMatchObject({ name: "Fallback", phone: "555" })
    const links = await sixb.objects(Contact).byId("new@example.com").listLinks()
    expect(links).toMatchObject([{ targetId: "org-2" }])

    await sixb
      .objects(Contact)
      .upsert({ properties: { id: "new@example.com", name: "Application edit" } })
    failPipeline = true
    expect(
      (
        await send(
          "pipedrive",
          {
            ...person,
            revision: 10,
            email: "new@example.com",
            name: "Source changed",
            org: "org-1",
          },
          "pd-3"
        )
      ).status
    ).toBe(200)
    await waitFor(
      () => host.storage.pipelineRuns!.list({ projectId: host.id, pipelineId: pipeline.id }),
      (runs) => runs.runs.some((run) => run.status === "failed")
    )
    failPipeline = false
    const retry = await sixb.pipelines.request({ pipelineId: pipeline.id })
    await waitFor(
      () => host.storage.pipelineRuns!.getById({ projectId: host.id, id: retry.runId }),
      (run) => run?.status === "succeeded"
    )
    await waitFor(
      () => sixb.objects(Contact).byId("new@example.com").listLinks(),
      (rows) => rows.some((row) => row.targetId === "org-1")
    )
    expect((await contact("new@example.com"))?.properties.name).toBe("Application edit")
    expect(handled).toBe(4)

    expect(
      (
        await send(
          "pipedrive",
          { ...person, revision: 11, email: "new@example.com", phone: "999", org: "missing-org" },
          "pd-4"
        )
      ).status
    ).toBe(200)
    await waitFor(
      () => contact("new@example.com"),
      (value) => value?.properties.phone === "999"
    )
    expect(await sixb.objects(Contact).byId("new@example.com").listLinks()).toEqual([])
  } finally {
    await runtime.stop()
    await host.closeBroker()
  }
}, 25_000)
