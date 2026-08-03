import { afterEach, describe, expect, test } from "bun:test"
import type {
  DomainEvent,
  RuleDefinition,
  SixbErrorContext,
  SixbFailure,
  Storage,
} from "@sixb/core"
import {
  defineObjectType,
  InMemoryBroker,
  InMemoryStorage,
  link,
  OntologyRegistry,
  prop,
} from "@sixb/core"
import { attachSixbErrorReporter, flushSixbErrors } from "@sixb/core/internal/error-reporting"
import type { StoredDomainEvent, StoredObjectUpdatedEvent } from "@sixb/core/internal/events"
import { EventsRuntime } from "@sixb/core/internal/events"
import type { ObjectStorage, RulesStorage } from "@sixb/core/storage"
import { InMemoryRulesStorage } from "@sixb/core/storage"
import { createMaterializerTestFixture, type MaterializerTestFixture } from "@sixb/core/testing"
import type { RulesWorkerSixb } from "../src"
import { RulesWorker } from "../src"

/** What `onError` is handed: the portable record, and the live thrown value on the context. */
type Report = { failure: SixbFailure; context: SixbErrorContext & { cause: unknown } }

const projectId = "project-a"

const postedRule: RuleDefinition = {
  kind: "rule",
  id: "transaction.posted",
  subject: {
    kind: "object",
    objectTypeId: "transaction",
  },
  predicate: {
    kind: "property",
    propertyId: "status",
    op: "eq",
    value: "posted",
  },
}

const hasDocumentRule: RuleDefinition = {
  kind: "rule",
  id: "transaction.has-document",
  subject: { kind: "object", objectTypeId: "transaction" },
  predicate: { kind: "link", linkId: "document", op: "exists" },
}

const alsoPostedRule: RuleDefinition = {
  ...postedRule,
  id: "transaction.also-posted",
}

const Document = defineObjectType({
  id: "document",
  name: "Document",
  properties: [prop("id", "string", { primary: true, required: true })],
})
const Transaction = defineObjectType({
  id: "transaction",
  name: "Transaction",
  properties: [prop("id", "string", { primary: true, required: true }), prop("status", "string")],
  links: [link("document", Document)],
})
const ontology = new OntologyRegistry({ sources: [Transaction, Document] })
const fixturesByStorage = new WeakMap<Storage, MaterializerTestFixture>()

const workers: RulesWorker[] = []

afterEach(async () => {
  for (const worker of workers) {
    await worker.stop().catch(() => {})
  }
  workers.length = 0
})

describe("RulesWorker", () => {
  test("constructor rejects runtimes with no registered rules", () => {
    expect(() => new RulesWorker(createRuntime({ rules: [] }))).toThrow(
      "[SixbRulesWorker] Rules workers require at least one registered rule."
    )
  })

  test("constructor rejects runtimes without storage.rules", () => {
    expect(
      () =>
        new RulesWorker(
          createRuntime({
            storage: createStorageWithoutRules(),
          })
        )
    ).toThrow("[SixbRulesWorker] Rules workers require storage.rules support.")
  })

  test("constructor bounds reconciliation pages", () => {
    expect(() => new RulesWorker(createRuntime(), { reconciliationPageSize: 1_001 })).toThrow(
      "reconciliationPageSize must not exceed 1000"
    )
  })

  test("worker subscribes to object and link event types", async () => {
    const events = new RecordingEventsRuntime()
    const worker = track(new RulesWorker(createRuntime({ events })))

    await worker.start()

    expect(events.subscriptions).toEqual([
      {
        types: [
          "object.created",
          "object.updated",
          "object.deleted",
          "link.created",
          "link.updated",
          "link.deleted",
        ],
      },
    ])
  })

  test("worker drains pending evaluations on stop", async () => {
    const rules = new DelayedRulesStorage()
    const events = createEventsRuntime()
    const storage = createStorage({ rules })
    await seedCurrentObject(storage, "posted")
    const worker = track(
      new RulesWorker(
        createRuntime({
          events,
          storage,
        })
      )
    )
    await worker.start()

    await events.publishEnvelopes([objectUpdatedEvent("posted")])
    await rules.waitForGetActive()

    let stopped = false
    const stop = worker.stop().then(() => {
      stopped = true
    })
    await Bun.sleep(20)
    expect(stopped).toBe(false)

    rules.releaseGetActive()
    await stop

    expect(stopped).toBe(true)
    expect(await ruleEventTypes(events)).toEqual(["rule.triggered"])
  })

  test("worker does not accept new events after stop", async () => {
    const events = createEventsRuntime()
    const worker = track(new RulesWorker(createRuntime({ events })))
    await worker.start()
    await worker.stop()

    await events.publishEnvelopes([objectUpdatedEvent("posted")])
    await Bun.sleep(20)

    expect(await ruleEventTypes(events)).toEqual([])
  })

  test("evaluation errors are reported and do not stop later events", async () => {
    // The worker no longer prints beside the report: with a handler configured the escalation is the
    // only trace, and without one the channel's own default prints it.
    const originalError = console.error
    console.error = () => {}

    try {
      const events = createEventsRuntime()
      const storage = createStorage()
      const objects = new ThrowOnceObjectStorage(storage.objects)
      replaceObjectStorage(storage, objects.storage)
      const reports: Report[] = []
      const runtime = createRuntime({ events, storage })
      attachSixbErrorReporter(runtime, (failure, context) => {
        reports.push({ failure, context })
      })
      await seedCurrentObject(storage, "posted")
      await seedCurrentObject(storage, "posted", "tx-2")
      const worker = track(new RulesWorker(runtime))
      await worker.start()

      await events.publishEnvelopes([objectUpdatedEvent("posted")])
      await waitFor(() => reports.length === 1)

      await events.publishEnvelopes([objectUpdatedEvent("posted", "tx-2")])
      await worker.stop()
      await flushSixbErrors(runtime)

      // The candidate is isolated, so the report names the rule and subject that actually failed
      // instead of only the batch it belonged to.
      expect(reports).toHaveLength(1)
      expect(reports[0]?.context).toMatchObject({
        type: "rule.evaluation.failed",
        source: "live",
        eventIds: ["event-tx-1-posted"],
        ruleId: "transaction.posted",
        subject: { objectTypeId: "transaction", primaryId: "tx-1" },
      })
      expect(await ruleEventTypes(events)).toEqual(["rule.triggered", "rule.triggered"])
    } finally {
      console.error = originalError
    }
  })

  test("startup reconciliation repairs an object event missed while offline", async () => {
    const events = createEventsRuntime()
    const storage = new InMemoryStorage()
    await seedCurrentObject(storage, "posted")
    const worker = track(
      new RulesWorker(createRuntime({ events, storage }), {
        reconciliationPageSize: 1,
      })
    )

    await worker.start()
    await waitFor(async () => (await ruleEventTypes(events)).length === 1)
    await worker.stop()

    expect(await ruleEventTypes(events)).toEqual(["rule.triggered"])
  })

  test("startup reconciliation resolves active state for a deleted subject", async () => {
    const events = createEventsRuntime()
    const storage = new InMemoryStorage()
    const [triggered] = await events.append({
      events: [
        {
          type: "rule.triggered",
          payload: {
            ruleId: postedRule.id,
            subject: { kind: "object", objectTypeId: "transaction", primaryId: "deleted" },
            triggeredAt: "2026-05-07T10:00:00.000Z",
          },
        },
      ],
    })
    if (!triggered || triggered.type !== "rule.triggered") throw new Error("Missing trigger event")
    await storage.rules.applyTriggered(triggered)

    const worker = track(new RulesWorker(createRuntime({ events, storage })))
    await worker.start()
    await waitFor(async () => (await ruleEventTypes(events)).includes("rule.resolved"))
    await worker.stop()

    expect(
      await storage.rules.getActive({
        projectId,
        ruleId: postedRule.id,
        subject: { kind: "object", objectTypeId: "transaction", primaryId: "deleted" },
      })
    ).toBeNull()
  })

  test("reconciliation uses stable pages and evaluates every subject", async () => {
    const events = createEventsRuntime()
    const storage = new InMemoryStorage()
    await seedCurrentObject(storage, "posted", "tx-3")
    await seedCurrentObject(storage, "posted", "tx-1")
    await seedCurrentObject(storage, "posted", "tx-2")
    const worker = track(
      new RulesWorker(createRuntime({ events, storage }), {
        reconciliationPageSize: 1,
      })
    )

    await worker.start()
    await waitFor(async () => (await ruleEventTypes(events)).length === 3)
    await worker.stop()

    expect(
      (await storage.rules.listActive({ projectId, ruleId: postedRule.id })).states.map(
        (state) => state.subject.primaryId
      )
    ).toEqual(["tx-3", "tx-2", "tx-1"])
  })

  test("reconciliation scans one object type once for all of its rules", async () => {
    const events = createEventsRuntime()
    const storage = createStorage()
    const objects = new CountingReconciliationObjectStorage(storage.objects)
    replaceObjectStorage(storage, objects.storage)
    await seedCurrentObject(storage, "posted")
    const worker = track(
      new RulesWorker(createRuntime({ rules: [postedRule, alsoPostedRule], events, storage }))
    )

    await worker.start()
    await waitFor(async () => (await ruleEventTypes(events)).length === 2)
    await worker.stop()

    expect(objects.pageReads).toBe(1)
  })

  test("serializes live evaluation behind reconciliation", async () => {
    const events = createEventsRuntime()
    const storage = createStorage()
    const objects = new BlockingReconciliationObjectStorage(storage.objects)
    replaceObjectStorage(storage, objects.storage)
    await seedCurrentObject(storage, "posted")
    const worker = track(new RulesWorker(createRuntime({ events, storage })))

    await worker.start()
    await objects.waitForReconciliation()
    await events.publishEnvelopes([objectUpdatedEvent("posted")])
    await Bun.sleep(20)

    expect(objects.liveReads).toBe(0)
    objects.releaseReconciliation()
    await waitFor(() => objects.liveReads > 0)
    await worker.stop()
  })

  test("loads reconciliation links through one batch port", async () => {
    const storage = createStorage()
    const objects = new RecordingBatchLinkObjectStorage(storage.objects)
    replaceObjectStorage(storage, objects.storage)
    await seedCurrentObject(storage, "posted")
    const worker = track(new RulesWorker(createRuntime({ rules: [hasDocumentRule], storage })))

    await worker.start()
    await waitFor(() => objects.batchReads === 1)
    await worker.stop()

    expect(objects.directReads).toBe(0)
  })

  test("one failing candidate does not cancel the rest of its batch", async () => {
    const originalError = console.error
    console.error = () => {}

    try {
      const reports: Report[] = []
      const events = createEventsRuntime()
      const storage = createStorage()
      const objects = new FailOneSubjectObjectStorage(storage.objects, "tx-1")
      replaceObjectStorage(storage, objects.storage)
      await seedCurrentObject(storage, "posted")
      await seedCurrentObject(storage, "posted", "tx-2")

      const runtime = createRuntime({ events, storage })
      attachSixbErrorReporter(runtime, (failure, context) => {
        reports.push({ failure, context })
      })
      const worker = track(new RulesWorker(runtime))
      await worker.start()

      // Both subjects are in the SAME batch. The first one throws in object storage.
      await events.publishEnvelopes([
        objectUpdatedEvent("posted"),
        objectUpdatedEvent("posted", "tx-2"),
      ])
      await waitFor(() => liveFailures(reports).length === 1)
      await worker.stop()
      await flushSixbErrors(runtime)

      // The claim: tx-2 was still evaluated even though tx-1, ahead of it in the batch, threw.
      // Asserting the read rather than the resulting event is deliberate — reconciliation repairs a
      // dropped candidate within one interval, so an event assertion cannot tell isolation apart
      // from the safety net having done the work.
      expect(objects.subjectReads).toContain("tx-2")

      // Exactly one live failure, and it names the candidate rather than just the batch.
      const live = liveFailures(reports)
      expect(live).toHaveLength(1)
      expect(live[0]).toMatchObject({
        type: "rule.evaluation.failed",
        source: "live",
        ruleId: "transaction.posted",
        subject: { objectTypeId: "transaction", primaryId: "tx-1" },
      })

      // A permanently broken subject also breaks the repair path, and that is reported separately —
      // which is the whole point of `source`: a failing reconciliation means state stops converging.
      expect(
        reports.some(
          (report) =>
            report.context.type === "rule.evaluation.failed" &&
            report.context.source === "reconciliation"
        )
      ).toBe(true)
    } finally {
      console.error = originalError
    }
  })
})

class RecordingEventsRuntime extends EventsRuntime {
  readonly subscriptions: {
    readonly types?: readonly DomainEvent["type"][]
  }[] = []

  constructor() {
    super({ projectId, broker: new InMemoryBroker(), host: null })
  }

  override subscribe(
    params: {
      types?: readonly DomainEvent["type"][]
    },
    handler: (events: readonly StoredDomainEvent[]) => void
  ): Promise<() => void> {
    this.subscriptions.push(params)
    return super.subscribe(params, handler)
  }
}

class DelayedRulesStorage extends InMemoryRulesStorage {
  private getActiveStarted = createDeferred<void>()
  private getActiveRelease = createDeferred<void>()

  override async getActive(
    params: Parameters<RulesStorage["getActive"]>[0]
  ): ReturnType<RulesStorage["getActive"]> {
    this.getActiveStarted.resolve()
    await this.getActiveRelease.promise
    return super.getActive(params)
  }

  async waitForGetActive(): Promise<void> {
    await this.getActiveStarted.promise
  }

  releaseGetActive(): void {
    this.getActiveRelease.resolve()
  }
}

class ThrowOnceObjectStorage {
  private shouldThrow = true
  readonly storage: ObjectStorage

  constructor(delegate: ObjectStorage) {
    this.storage = objectStorageFacade(delegate, {
      getByPrimaryId: async (params) => {
        if (this.shouldThrow) {
          this.shouldThrow = false
          throw new Error("Object storage failed.")
        }
        return delegate.getByPrimaryId(params)
      },
    })
  }
}

/**
 * Fails one subject deterministically through both live and reconciliation reads.
 *
 * Individual reads still identify which live candidates ran after the failure.
 */
class FailOneSubjectObjectStorage {
  readonly subjectReads: string[] = []
  readonly storage: ObjectStorage

  constructor(delegate: ObjectStorage, failingPrimaryId: string) {
    this.storage = objectStorageFacade(delegate, {
      getByPrimaryId: async (params) => {
        this.subjectReads.push(params.primaryId)
        if (params.primaryId === failingPrimaryId) {
          throw new Error("Object storage failed.")
        }
        return delegate.getByPrimaryId(params)
      },
      listByPrimaryIdPage: async (params) => {
        const page = await delegate.listByPrimaryIdPage(params)
        if (page.objects.some((object) => object.primaryId === failingPrimaryId)) {
          throw new Error("Object storage failed.")
        }
        return page
      },
    })
  }
}

class BlockingReconciliationObjectStorage {
  private readonly reconciliationStarted = createDeferred<void>()
  private readonly reconciliationRelease = createDeferred<void>()
  liveReads = 0
  readonly storage: ObjectStorage

  constructor(delegate: ObjectStorage) {
    this.storage = objectStorageFacade(delegate, {
      listByPrimaryIdPage: async (params) => {
        this.reconciliationStarted.resolve()
        await this.reconciliationRelease.promise
        return delegate.listByPrimaryIdPage(params)
      },
      getByPrimaryId: async (params) => {
        this.liveReads += 1
        return delegate.getByPrimaryId(params)
      },
    })
  }

  waitForReconciliation(): Promise<void> {
    return this.reconciliationStarted.promise
  }

  releaseReconciliation(): void {
    this.reconciliationRelease.resolve()
  }
}

class RecordingBatchLinkObjectStorage {
  batchReads = 0
  directReads = 0
  readonly storage: ObjectStorage

  constructor(delegate: ObjectStorage) {
    this.storage = objectStorageFacade(delegate, {
      listLinksBatch: async () => {
        this.batchReads += 1
        return new Map()
      },
      listLinks: async (params) => {
        this.directReads += 1
        return delegate.listLinks(params)
      },
    })
  }
}

class CountingReconciliationObjectStorage {
  pageReads = 0
  readonly storage: ObjectStorage

  constructor(delegate: ObjectStorage) {
    this.storage = objectStorageFacade(delegate, {
      listByPrimaryIdPage: async (params) => {
        this.pageReads += 1
        return delegate.listByPrimaryIdPage(params)
      },
    })
  }
}

function createRuntime(
  options: {
    readonly rules?: readonly RuleDefinition[]
    readonly events?: EventsRuntime
    readonly storage?: Storage
  } = {}
): RulesWorkerSixb {
  const rules = options.rules ?? [postedRule]
  return {
    id: projectId,
    events: options.events ?? createEventsRuntime(),
    storage: options.storage ?? new InMemoryStorage(),
    listRules: () => rules,
    getRuleById: (ruleId) => rules.find((rule) => rule.id === ruleId) ?? null,
  }
}

function createStorage(options: { readonly rules?: RulesStorage } = {}): Storage {
  const storage = new InMemoryStorage()
  return Object.assign(storage, {
    rules: options.rules ?? storage.rules,
  })
}

function replaceObjectStorage(storage: Storage, objects: ObjectStorage): void {
  Object.assign(storage, { objects })
}

function objectStorageFacade(
  delegate: ObjectStorage,
  overrides: Partial<ObjectStorage>
): ObjectStorage {
  return new Proxy(delegate, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) {
        return Reflect.get(overrides, property, overrides)
      }
      return Reflect.get(target, property, target)
    },
  })
}

function createStorageWithoutRules(): Storage {
  return Object.assign(new InMemoryStorage(), {
    rules: undefined,
  })
}

function objectUpdatedEvent(
  status: string,
  primaryId = "tx-1"
): Omit<StoredObjectUpdatedEvent, "cursor"> {
  return {
    id: `event-${primaryId}-${status}`,
    schemaVersion: 1,
    projectId,
    occurredAt: "2026-05-07T10:00:00.000Z",
    origin: { kind: "runtime", requestId: `request-${primaryId}-${status}` },
    commitId: `commit-${primaryId}-${status}`,
    commitOrdinal: 0,
    type: "object.updated",
    topic: "objects",
    partitionKey: `transaction:${primaryId}`,
    payload: {
      objectTypeId: "transaction",
      primaryId,
      properties: { status },
      propertyChanges: {},
    },
  }
}

async function seedCurrentObject(
  storage: Storage,
  status: string,
  primaryId = "tx-1"
): Promise<void> {
  await materializerFixture(storage).seed({
    objects: [
      {
        ref: { objectTypeId: "transaction", primaryId },
        properties: { id: primaryId, status },
      },
    ],
  })
}

function materializerFixture(storage: Storage): MaterializerTestFixture {
  const existing = fixturesByStorage.get(storage)
  if (existing) return existing
  const fixture = createMaterializerTestFixture({ projectId, ontology, storage })
  fixturesByStorage.set(storage, fixture)
  return fixture
}

async function ruleEventTypes(events: EventsRuntime): Promise<readonly string[]> {
  const readEvents = await events.read({
    topics: ["rules"],
  })
  return readEvents.map((event) => event.type)
}

function createEventsRuntime(): EventsRuntime {
  return new EventsRuntime({ projectId, broker: new InMemoryBroker(), host: null })
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await fn()) return
    await Bun.sleep(10)
  }
  throw new Error("Timed out waiting for condition.")
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void

  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

function track(worker: RulesWorker): RulesWorker {
  workers.push(worker)
  return worker
}

function liveFailures(
  reports: readonly { readonly context: SixbErrorContext }[]
): readonly Extract<SixbErrorContext, { type: "rule.evaluation.failed" }>[] {
  return reports.flatMap((report) =>
    report.context.type === "rule.evaluation.failed" && report.context.source === "live"
      ? [report.context]
      : []
  )
}
