import { afterEach, describe, expect, test } from "bun:test"
import type { DomainEvent, RuleDefinition, SixbErrorContext, Storage } from "@sixb/core"
import { InMemoryBroker, InMemoryStorage } from "@sixb/core"
import { attachSixbErrorReporter, flushSixbErrors } from "@sixb/core/internal/error-reporting"
import type { StoredDomainEvent, StoredObjectUpdatedEvent } from "@sixb/core/internal/events"
import { EventsRuntime } from "@sixb/core/internal/events"
import type { ObjectStorage, RulesStorage, TimeseriesStorage } from "@sixb/core/storage"
import { InMemoryObjectStorage, InMemoryRulesStorage } from "@sixb/core/storage"
import type { RulesWorkerSixb } from "../src"
import { RulesWorker } from "../src"

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

  test("evaluation errors are logged and do not stop later events", async () => {
    const originalError = console.error
    const errors: unknown[][] = []
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }

    try {
      const events = createEventsRuntime()
      const objects = new ThrowOnceObjectStorage()
      const storage = createStorage({ objects })
      const reports: Array<{ error: Error; context: SixbErrorContext }> = []
      const runtime = createRuntime({ events, storage })
      attachSixbErrorReporter(runtime, (error, context) => {
        reports.push({ error, context })
      })
      await seedCurrentObject(storage, "posted")
      await seedCurrentObject(storage, "posted", "tx-2")
      const worker = track(new RulesWorker(runtime))
      await worker.start()

      await events.publishEnvelopes([objectUpdatedEvent("posted")])
      await waitFor(() => errors.length === 1)

      await events.publishEnvelopes([objectUpdatedEvent("posted", "tx-2")])
      await worker.stop()
      await flushSixbErrors(runtime)

      // The candidate is isolated, so the report names the rule and subject that actually failed
      // instead of only the batch it belonged to.
      expect(String(errors[0]?.[0])).toContain(
        "[SixbRulesWorker] Rule 'transaction.posted' on transaction:tx-1 failed:"
      )
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
    const objects = new CountingReconciliationObjectStorage()
    const storage = createStorage({ objects })
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
    const objects = new BlockingReconciliationObjectStorage()
    const storage = createStorage({ objects })
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
    const objects = new RecordingBatchLinkObjectStorage()
    const storage = createStorage({ objects })
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
      const reports: { error: Error; context: SixbErrorContext }[] = []
      const events = createEventsRuntime()
      const objects = new FailOneSubjectObjectStorage("tx-1")
      const storage = createStorage({ objects })
      await seedCurrentObject(storage, "posted")
      await seedCurrentObject(storage, "posted", "tx-2")

      const runtime = createRuntime({ events, storage })
      attachSixbErrorReporter(runtime, (error, context) => {
        reports.push({ error, context })
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
    super({ projectId, broker: new InMemoryBroker() })
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

class ThrowOnceObjectStorage extends InMemoryObjectStorage {
  private shouldThrow = true

  override async getByPrimaryId(
    params: Parameters<ObjectStorage["getByPrimaryId"]>[0]
  ): ReturnType<ObjectStorage["getByPrimaryId"]> {
    if (this.shouldThrow) {
      this.shouldThrow = false
      throw new Error("Object storage failed.")
    }

    return super.getByPrimaryId(params)
  }
}

/**
 * Fails one subject deterministically and records which subjects were read individually.
 *
 * Reconciliation pages through `listByPrimaryIdPage`, so a `getByPrimaryId` for a given subject can
 * only come from live evaluation — which is what makes the read a usable isolation signal.
 */
class FailOneSubjectObjectStorage extends InMemoryObjectStorage {
  readonly subjectReads: string[] = []

  constructor(private readonly failingPrimaryId: string) {
    super()
  }

  override async getByPrimaryId(
    params: Parameters<ObjectStorage["getByPrimaryId"]>[0]
  ): ReturnType<ObjectStorage["getByPrimaryId"]> {
    this.subjectReads.push(params.primaryId)
    if (params.primaryId === this.failingPrimaryId) {
      throw new Error("Object storage failed.")
    }

    return super.getByPrimaryId(params)
  }
}

class BlockingReconciliationObjectStorage extends InMemoryObjectStorage {
  private readonly reconciliationStarted = createDeferred<void>()
  private readonly reconciliationRelease = createDeferred<void>()
  liveReads = 0

  override async listByPrimaryIdPage(
    params: Parameters<ObjectStorage["listByPrimaryIdPage"]>[0]
  ): ReturnType<ObjectStorage["listByPrimaryIdPage"]> {
    this.reconciliationStarted.resolve()
    await this.reconciliationRelease.promise
    return super.listByPrimaryIdPage(params)
  }

  override async getByPrimaryId(
    params: Parameters<ObjectStorage["getByPrimaryId"]>[0]
  ): ReturnType<ObjectStorage["getByPrimaryId"]> {
    this.liveReads += 1
    return super.getByPrimaryId(params)
  }

  waitForReconciliation(): Promise<void> {
    return this.reconciliationStarted.promise
  }

  releaseReconciliation(): void {
    this.reconciliationRelease.resolve()
  }
}

class RecordingBatchLinkObjectStorage extends InMemoryObjectStorage {
  batchReads = 0
  directReads = 0

  override async listLinksBatch(): ReturnType<ObjectStorage["listLinksBatch"]> {
    this.batchReads += 1
    return new Map()
  }

  override async listLinks(
    params: Parameters<ObjectStorage["listLinks"]>[0]
  ): ReturnType<ObjectStorage["listLinks"]> {
    this.directReads += 1
    return super.listLinks(params)
  }
}

class CountingReconciliationObjectStorage extends InMemoryObjectStorage {
  pageReads = 0

  override async listByPrimaryIdPage(
    params: Parameters<ObjectStorage["listByPrimaryIdPage"]>[0]
  ): ReturnType<ObjectStorage["listByPrimaryIdPage"]> {
    this.pageReads += 1
    return super.listByPrimaryIdPage(params)
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
    getRuleDefinitions: () => rules,
    getRuleById: (ruleId) => rules.find((rule) => rule.id === ruleId) ?? null,
  }
}

function createStorage(
  options: {
    readonly objects?: ObjectStorage
    readonly timeseries?: TimeseriesStorage
    readonly rules?: RulesStorage
  } = {}
): Storage {
  const storage = new InMemoryStorage()
  return Object.assign(storage, {
    objects: options.objects ?? storage.objects,
    timeseries: options.timeseries ?? storage.timeseries,
    rules: options.rules ?? storage.rules,
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
  await storage.objects.applyObjectUpsert({
    ...objectUpdatedEvent(status, primaryId),
    cursor: `seed-${primaryId}`,
  })
}

async function ruleEventTypes(events: EventsRuntime): Promise<readonly string[]> {
  const readEvents = await events.read({
    topics: ["rules"],
  })
  return readEvents.map((event) => event.type)
}

function createEventsRuntime(): EventsRuntime {
  return new EventsRuntime({ projectId, broker: new InMemoryBroker() })
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
