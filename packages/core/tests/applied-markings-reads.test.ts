import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { AuthorizationError, decimal, type ObjectQuery, type StoredDomainEvent } from "../src"
import {
  createAuthorizedObjectReader,
  readerClearance,
} from "../src/execution/authorized-object-reader"
import { createDelegatedRequestScope, createTestingScope } from "../src/execution/scopes"
import { resolvePropertyClearance } from "../src/objects/property-clearance"
import type { OntologyRegistry } from "../src/ontology"
import { getAppliedMarkings } from "../src/security/applied-markings-host"
import {
  type AppliedMarkingsSnapshot,
  NO_APPLIED_MARKINGS,
} from "../src/security/applied-markings-snapshot"
import { createTestSixb } from "../src/testing"
import {
  archiveInvoice,
  Customer,
  createAppliedProject,
  Invoice,
  type InvoiceProjection,
  projectId,
  remindCustomers,
} from "./applied-markings-fixture"
import { waitFor } from "./test-runtime-deps"

// Readers receive the objects a projection applied under the markings of the dataset version it
// applied: a property keeps a marking its column carried, and an object type or link whose key
// column carried one is unreadable, until the projection applies a version the code allows.

const warn = spyOn(console, "warn").mockImplementation(() => {})
afterAll(() => warn.mockRestore())

const invoices: ObjectQuery = { kind: "start", objectTypeId: Invoice.id }

/** Day 1: the title was computed from the amount. */
const titleFromAmount = { title: ["amount"] }

async function deploy(
  options: {
    readonly variant?: InvoiceProjection
    readonly lineage?: Partial<Record<string, readonly string[]>> | null
  } = {}
) {
  const app = await createAppliedProject({ variant: options.variant })
  const trusted = createTestSixb(app.host)

  await trusted.objects(Customer).upsert({ properties: { id: "c1", name: "Acme" } })
  await trusted.objects(Invoice).upsert({
    properties: {
      id: "inv-1",
      customerId: "c1",
      title: "120",
      summary: "Boiler",
      amount: decimal("120"),
    },
  })
  await trusted.objects.upsertLink(Invoice.id, "inv-1", "customer", {
    targetTypeId: Customer.id,
    targetId: "c1",
  })

  const version = await app.normalized(
    options.lineage === undefined ? titleFromAmount : options.lineage
  )
  app.apply(version)

  return {
    ...app,
    version,
    trusted,
    sales: createTestSixb(app.host, { authorization: app.contextFor(["sales"]) }),
    finance: createTestSixb(app.host, { authorization: app.contextFor(["finance"]) }),
    /** Apply a version the code allows, as a projection in this process would. */
    async fix() {
      app.apply(await app.normalized())
      getAppliedMarkings(app.host).invalidate()
    },
  }
}

const denied = (marking: string) =>
  expect.objectContaining({ name: "AuthorizationError", grantKey: `clearance:marking:${marking}` })

describe("a property keeps the markings of the version it was projected from", () => {
  test("reads omit it and list it in redactions until a compliant version applies", async () => {
    const app = await deploy()

    const invoice = await app.sales.objects.get(Invoice.id, "inv-1")
    expect(invoice?.properties).toEqual({ id: "inv-1", customerId: "c1", summary: "Boiler" })
    expect(Object.keys(invoice?.redactions ?? {}).sort()).toEqual(["amount", "title"])

    const listed = await app.sales.objects.list({ objectTypeIds: [Invoice.id] })
    expect(listed.objects[0]?.properties.title).toBeUndefined()

    // Every redacted row shares one frozen record per type, resolved once for the snapshot.
    const again = await app.sales.objects.get(Invoice.id, "inv-1")
    expect(again?.redactions).toBe(invoice?.redactions)
    expect(Object.isFrozen(invoice?.redactions)).toBe(true)

    expect((await app.finance.objects.get(Invoice.id, "inv-1"))?.properties.title).toBe("120")
    expect((await app.trusted.objects.get(Invoice.id, "inv-1"))?.properties.title).toBe("120")

    await app.fix()
    const fixed = await app.sales.objects.get(Invoice.id, "inv-1")
    expect(fixed?.properties.title).toBe("120")
    expect(Object.keys(fixed?.redactions ?? {})).toEqual(["amount"])
  })

  // Reproduce: drop the snapshot argument from resolvePropertyClearance in the reader's
  // #clearanceNow; every request below succeeds.
  test("it cannot select, order, or aggregate objects", async () => {
    const app = await deploy()
    const byTitle: ObjectQuery = {
      kind: "filter",
      input: invoices,
      predicate: { op: "eq", propertyId: "title", value: "120" },
    }

    await expect(app.sales.objects.executeQuery({ query: byTitle })).rejects.toThrow(
      "[Sixb] Cannot filter by 'Invoice.title' at '$.predicate': it requires clearance for marking 'financial'."
    )

    const rejected = [
      () => app.sales.objects.count({ query: byTitle }),
      () =>
        app.sales.objects.executeQuery({
          query: {
            kind: "sort",
            input: invoices,
            fields: [{ kind: "property", propertyId: "title" }],
          },
        }),
      () =>
        app.sales.objects.facet({ query: invoices, facets: [{ propertyId: "title", limit: 5 }] }),
      () =>
        app.sales.objects.executeQuery({
          query: { kind: "text", input: invoices, query: "120", fields: ["title"] },
        }),
    ]
    for (const request of rejected) await expect(request()).rejects.toEqual(denied("financial"))

    // A search without fields searches the other default text fields.
    const search = (text: string) =>
      app.sales.objects.executeQuery({ query: { kind: "text", input: invoices, query: text } })
    expect((await search("120")).objects).toEqual([])
    expect((await search("Boiler")).objects.map((row) => row.primaryId)).toEqual(["inv-1"])
    expect(await app.finance.objects.count({ query: byTitle })).toMatchObject({ count: 1 })
  })

  test("object events are redacted under the markings applied now", async () => {
    const app = await deploy()
    const created = (events: readonly StoredDomainEvent[]) =>
      events.find(
        (event) =>
          event.type === "object.created" &&
          event.topic === "objects" &&
          event.payload.objectTypeId === Invoice.id
      )

    const read = created(await app.sales.events.read())
    expect(read?.type === "object.created" && read.payload.properties).toEqual({
      id: "inv-1",
      customerId: "c1",
      summary: "Boiler",
    })
    expect(
      read?.type === "object.created" && Object.keys(read.payload.redactions ?? {}).sort()
    ).toEqual(["amount", "title"])

    const stored = await app.host.events.read()
    expect(await app.sales.events.visible(stored)).toEqual(await app.sales.events.read())
  })
})

describe("an object type whose key column carried a marking is unreadable", () => {
  // Reproduce: drop the unreadableType loop from the reader's #assertObjectTypesViewable; the
  // read returns the invoice. Drop readsUnreadable from the events runtime's visible; its events
  // are delivered.
  test("reads are denied like a type the reader has no view grant for", async () => {
    const app = await deploy({ lineage: null })
    const message = `[Sixb] Cannot read 'Invoice' until projection 'invoices' applies a compliant version: in the version '${app.version.versionId}' it applied, column 'invoices_normalized.id', which becomes the id of 'Invoice', carries marking 'financial'.`

    await expect(app.sales.objects.get(Invoice.id, "inv-1")).rejects.toThrow(message)
    await expect(app.sales.objects.get(Invoice.id, "inv-1")).rejects.toBeInstanceOf(
      AuthorizationError
    )
    await expect(app.sales.objects.list({ objectTypeIds: [Invoice.id] })).rejects.toEqual(
      denied("financial")
    )

    // A list that names no type leaves it out.
    const untyped = await app.sales.objects.list({})
    expect(untyped.objects.map((row) => row.objectTypeId)).toEqual([Customer.id])

    const queries: ObjectQuery[] = [
      invoices,
      { kind: "refs", refs: [{ objectTypeId: Invoice.id, primaryId: "inv-1" }] },
      {
        kind: "traverse",
        input: { kind: "start", objectTypeId: Customer.id },
        linkId: "customer",
        direction: "incoming",
        sourceObjectTypeId: Invoice.id,
      },
    ]
    for (const query of queries) {
      await expect(app.sales.objects.executeQuery({ query })).rejects.toEqual(denied("financial"))
    }

    await expect(
      app.sales.objects.queryLinks({
        query: { kind: "start", objectTypeId: Customer.id },
        direction: "incoming",
      })
    ).rejects.toEqual(denied("financial"))
    expect(
      await app.sales.objects.listLinks({ objectTypeId: Customer.id, objectId: "c1" })
    ).toEqual([])

    // Its events reveal its ids: they are not delivered.
    const events = await app.sales.events.read()
    expect(
      events.filter(
        (event) => "objectTypeId" in event.payload && event.payload.objectTypeId === Invoice.id
      )
    ).toEqual([])
    expect(events.filter((event) => event.topic === "links")).toEqual([])

    expect(await app.finance.objects.get(Invoice.id, "inv-1")).toMatchObject({ primaryId: "inv-1" })
    expect(await app.trusted.objects.get(Invoice.id, "inv-1")).toMatchObject({ primaryId: "inv-1" })

    await app.fix()
    expect(await app.sales.objects.get(Invoice.id, "inv-1")).toMatchObject({ primaryId: "inv-1" })
  })

  // Reproduce: drop the assertTargetsReadable call from writtenRowRedactor; the upsert commits.
  test("an upsert is refused, since it returns the merged row", async () => {
    const app = await deploy({ lineage: null })
    await app.host.storage.auth?.users.create({
      projectId,
      id: "user-sales",
      email: "s@example.com",
    })

    await expect(
      app.sales.objects.upsert(Invoice.id, { id: "inv-1", title: "Edited" })
    ).rejects.toEqual(denied("financial"))
    expect((await app.trusted.objects.get(Invoice.id, "inv-1"))?.properties.title).toBe("120")
  })

  // Reproduce: drop the assertReadable call from assertCanWriteLinks; the probe of 'inv-1' writes
  // a link and the probe of 'inv-404' answers that it does not exist. Drop it from deleteObject;
  // the delete commits.
  test("link writes and deletes are refused, before they look up what they name", async () => {
    const app = await deploy({ lineage: null })
    await app.host.storage.auth?.users.create({
      projectId,
      id: "user-sales",
      email: "s@example.com",
    })

    const target = { targetTypeId: Customer.id, targetId: "c1" }
    for (const invoiceId of ["inv-1", "inv-404"]) {
      await expect(
        app.sales.objects.upsertLink(Invoice.id, invoiceId, "customer", target)
      ).rejects.toEqual(denied("financial"))
      await expect(
        app.sales.objects.removeLink(Invoice.id, invoiceId, "customer", target)
      ).rejects.toEqual(denied("financial"))
      await expect(
        app.sales.objects.upsertLinkBatch([
          { objectTypeId: Invoice.id, sourceId: invoiceId, linkId: "customer", target },
        ])
      ).rejects.toEqual(denied("financial"))
    }

    const invoice = app.sales.objects(Invoice).byId("inv-1")
    await expect(invoice.delete()).rejects.toEqual(denied("financial"))
    await expect(invoice.restore()).rejects.toEqual(denied("financial"))
    expect(await app.trusted.objects.get(Invoice.id, "inv-1")).toMatchObject({ primaryId: "inv-1" })
  })

  // Reproduce: drop canReadActionRunSubject from runs.getById and the unreadable types from
  // runs.list in createActionsRuntime; the run on the sealed invoice is listed. Drop the
  // assertReadable call from requestAction; the request runs. Drop canReadActionRunSubject from
  // assertCallerMayHaveRun; reusing the run id answers that the run carries another request.
  test("action runs on it are hidden, and cannot be requested", async () => {
    const app = await deploy({ lineage: null })
    const subject = { kind: "object" as const, objectTypeId: Invoice.id, primaryId: "inv-1" }
    const { id: runId } = await app.trusted.actions.request({
      actionId: archiveInvoice.id,
      subject,
      params: {},
    })

    expect((await app.sales.actions.runs.list()).runs).toEqual([])
    expect(await app.sales.actions.runs.getById(runId)).toBeNull()
    await expect(
      app.sales.actions.request({ actionId: archiveInvoice.id, subject, params: {} })
    ).rejects.toEqual(denied("financial"))
    // Its run id answers another request like a run the reader cannot see.
    await expect(
      app.sales.actions.request({ actionId: remindCustomers.id, params: {}, runId })
    ).rejects.toThrow(`[Sixb] Action run '${runId}' is not visible to this principal.`)

    expect((await app.finance.actions.runs.list()).runs.map((run) => run.id)).toEqual([runId])
    expect(await app.finance.actions.runs.getById(runId)).toMatchObject({ id: runId })

    await app.fix()
    expect((await app.sales.actions.runs.list()).runs.map((run) => run.id)).toEqual([runId])
  })

  // Reproduce: drop the try/catch around visible in the events runtime's subscribe; the batch is
  // dropped without a warning.
  test("a subscription drops, with a warning, a batch whose markings cannot be enforced", async () => {
    const app = await deploy({ lineage: null })
    const delivered: StoredDomainEvent[] = []
    const unsubscribe = await app.sales.events.subscribe({}, (events) => {
      delivered.push(...events)
    })

    app.host.storage.ontology.sources.listActive = async () => {
      throw new Error("storage offline")
    }

    await app.trusted.objects(Customer).upsert({ properties: { id: "c2", name: "Beta" } })
    await waitFor(
      () => warn.mock.calls.flat().map(String),
      (messages) => messages.some((message) => message.includes("Dropped"))
    )

    unsubscribe()
    expect(delivered).toEqual([])
    expect(
      warn.mock.calls
        .flat()
        .map(String)
        .find((message) => message.includes("Dropped"))
    ).toMatch(
      /^\[Sixb\] Dropped 1 event\(s\) from cursor '.+' of a subscription, whose markings could not be enforced: \[Sixb\] Cannot read the dataset versions projections applied, so markings cannot be enforced: storage offline$/
    )
  })

  test("shared access is affected, trusted code is not", async () => {
    const app = await deploy({ lineage: null })
    const shared = app.host.withScope(
      createDelegatedRequestScope({
        projectId,
        requestId: "shared-request",
        correlationId: "shared-correlation",
        objectRead: {
          selection: {
            kind: "selected",
            roots: [
              {
                anchor: { objectTypeId: Invoice.id, primaryId: "inv-1" },
                node: { objects: [{ objectTypeId: Invoice.id, propertyIds: ["id"] }], links: [] },
              },
            ],
          },
          limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 10_000 },
        },
      })
    )

    await expect(shared.objects.get(Invoice.id, "inv-1")).rejects.toEqual(denied("financial"))
    expect((await app.trusted.events.read()).length).toBeGreaterThan(0)
  })
})

describe("a link whose key column carried a marking is unreadable", () => {
  // Reproduce: drop assertLinkQueryReadable from the reader's queryLinks; the link queries fail
  // with a storage contract error instead of a denial.
  test("its links are left out of lists and refused in queries", async () => {
    const app = await deploy({ variant: "linkField", lineage: { customer_id: ["amount"] } })

    // The invoice itself is readable.
    expect(await app.sales.objects.get(Invoice.id, "inv-1")).toMatchObject({ primaryId: "inv-1" })
    expect(
      await app.sales.objects.listLinks({ objectTypeId: Invoice.id, objectId: "inv-1" })
    ).toEqual([])
    await expect(
      app.sales.objects.executeQuery({
        query: { kind: "traverse", input: invoices, linkId: "customer", direction: "outgoing" },
      })
    ).rejects.toThrow(
      `[Sixb] Cannot read link 'Invoice.customer' until projection 'invoices' applies a compliant version: in the version '${app.version.versionId}' it applied, column 'invoices_normalized.customer_id', which keys link 'Invoice.customer', carries marking 'financial'.`
    )
    await expect(
      app.sales.objects.executeQuery({
        query: {
          kind: "expand",
          input: invoices,
          expansions: [{ linkId: "customer", direction: "outgoing" }],
        },
      })
    ).rejects.toEqual(denied("financial"))
    await expect(
      app.sales.objects.queryLinks({ query: invoices, direction: "outgoing" })
    ).rejects.toEqual(denied("financial"))

    // The customer's incoming links include it.
    await expect(
      app.sales.objects.queryLinks({
        query: { kind: "start", objectTypeId: Customer.id },
        direction: "incoming",
        linkId: "customer",
      })
    ).rejects.toEqual(denied("financial"))
    expect((await app.sales.events.read()).filter((event) => event.topic === "links")).toEqual([])

    expect(
      await app.finance.objects.listLinks({ objectTypeId: Invoice.id, objectId: "inv-1" })
    ).toHaveLength(1)
  })
})

describe("the clearance of the code alone", () => {
  test("is the same object when the applied versions add nothing a reader lacks", async () => {
    const app = await deploy({ lineage: {} })
    const ontology = app.host.definitions.ontology as OntologyRegistry
    const clearances = new Set<string>()
    const staticClearance = resolvePropertyClearance(ontology, clearances)

    const snapshot = await getAppliedMarkings(app.host).current()
    expect(snapshot).toBe(NO_APPLIED_MARKINGS)
    expect(resolvePropertyClearance(ontology, clearances, snapshot)).toBe(staticClearance)

    const reader = createAuthorizedObjectReader({
      scope: createTestingScope({ projectId, context: app.contextFor(["sales"]) }),
      ontology,
      objectStorage: app.host.storage.objects,
      appliedMarkings: getAppliedMarkings(app.host),
    })
    expect(await readerClearance(reader)).toBe(staticClearance)

    // A reader cleared for every marking the snapshot adds keeps it too.
    const added: AppliedMarkingsSnapshot = {
      ...NO_APPLIED_MARKINGS,
      properties: new Map([[Invoice.id, new Map([["title", new Set(["financial"])]])]]),
      markings: new Set(["financial"]),
    }

    const cleared = new Set(["financial"])
    expect(resolvePropertyClearance(ontology, cleared, added)).toBe(
      resolvePropertyClearance(ontology, cleared)
    )

    const withSurplus = resolvePropertyClearance(ontology, clearances, added)
    expect(withSurplus).not.toBe(staticClearance)
    expect(resolvePropertyClearance(ontology, clearances, added)).toBe(withSurplus)
    expect(withSurplus?.missingMarking(Invoice.id, "title")).toBe("financial")
    expect(withSurplus?.unreadableType(Invoice.id)).toBeUndefined()
  })

  // Reproduce: keep the applied markings in the reader's constructor whatever affects() says; the
  // cleared reader reads the sources again.
  test("steady state reads the sources once and classifies nothing again", async () => {
    const app = await deploy({ lineage: {} })
    const getVersion = spyOn(app.lake, "getVersion")
    const ontology = app.host.definitions.ontology as OntologyRegistry
    const staticClearance = resolvePropertyClearance(ontology, new Set())

    // The first read refreshes; the timer refreshes every few seconds after it.
    await app.sales.objects.list({ objectTypeIds: [Invoice.id] })
    const classified = getVersion.mock.calls.length
    expect(classified).toBeGreaterThan(0)

    for (let index = 1; index < 1_000; index += 1) {
      await app.sales.objects.list({ objectTypeIds: [Invoice.id] })
    }

    expect(app.calls.listActive).toBe(1)
    expect(getVersion).toHaveBeenCalledTimes(classified)

    const reader = createAuthorizedObjectReader({
      scope: createTestingScope({ projectId, context: app.contextFor(["sales"]) }),
      ontology,
      objectStorage: app.host.storage.objects,
      appliedMarkings: getAppliedMarkings(app.host),
    })
    expect(await readerClearance(reader)).toBe(staticClearance)

    // A reader cleared for every marking never reads them.
    const before = app.calls.listActive
    getAppliedMarkings(app.host).invalidate()
    await app.finance.objects.list({ objectTypeIds: [Invoice.id] })
    expect(app.calls.listActive).toBe(before)
  })
})

describe("an object event a projection emitted keeps the markings of its origin version", () => {
  async function projectionEvents() {
    const app = await deploy()
    const stored = (await app.host.events.read()).find(
      (event) =>
        event.type === "object.created" &&
        event.topic === "objects" &&
        event.payload.objectTypeId === Invoice.id
    )
    if (!stored) throw new Error("[Test] The invoice was not created.")

    /** The same event, as the projection would have emitted it from this version. */
    const from = (versionId: string): StoredDomainEvent => ({
      ...stored,
      origin: {
        kind: "projection",
        projectionId: "invoices",
        projectionRunId: "projection-run",
        datasetId: "invoices_normalized",
        datasetVersionId: versionId,
      },
    })

    const reads: string[] = []
    const getVersion = app.lake.getVersion.bind(app.lake)
    app.lake.getVersion = (datasetId, versionId) => {
      reads.push(versionId)
      return getVersion(datasetId, versionId)
    }

    const title = (event: StoredDomainEvent | undefined) =>
      event?.topic === "objects" && event.type !== "object.deleted"
        ? event.payload.properties.title
        : "not an object event"

    return { app, stored, from, reads, title }
  }

  // Reproduce: redact every event with readerClearance in the events runtime's visible; the
  // day-1 event delivers the title computed from the amount once the compliant version applies.
  test("an event from a leaking version stays redacted after a compliant version applies", async () => {
    const { app, stored, from, reads, title } = await projectionEvents()
    const leaking = from(app.version.versionId)
    await app.fix()
    const compliant = app.active[0]!.datasetVersion.versionId

    // The host reads the compliant version it applied first.
    await app.sales.objects.get(Invoice.id, "inv-1")

    reads.length = 0
    const [dayOne, fixed, runtime] = await app.sales.events.visible([
      leaking,
      from(compliant),
      stored,
    ])
    expect(title(dayOne)).toBeUndefined()
    expect(
      dayOne?.topic === "objects" && Object.keys(dayOne.payload.redactions ?? {}).sort()
    ).toEqual(["amount", "title"])
    expect(title(fixed)).toBe("120")
    // An event no projection emitted is read under the markings applied now.
    expect(title(runtime)).toBe("120")

    // One read per origin version, then none.
    expect(reads.sort()).toEqual([app.version.versionId, compliant].sort())
    await app.sales.events.visible([leaking, leaking])
    expect(reads).toHaveLength(2)
    expect(title((await app.finance.events.visible([leaking]))[0])).toBe("120")
  })

  // Reproduce: make AppliedMarkings.affects return true for any clearances; the cleared reader
  // reads the origin version.
  test("no version is read for a reader cleared for every column marking", async () => {
    const { app, from, reads } = await projectionEvents()
    reads.length = 0
    await app.finance.events.visible([from(app.version.versionId)])
    await app.trusted.events.visible([from(app.version.versionId)])
    expect(reads).toEqual([])
  })
})
