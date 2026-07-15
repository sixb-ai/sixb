import { afterEach, describe, expect, test } from "bun:test"
import type { DomainEvent, RuleDefinition, Storage } from "@sixb/core"
import {
  InMemoryBroker,
  InMemoryObjectStorage,
  InMemoryRulesStorage,
  InMemoryStorage,
} from "@sixb/core"
import type { EventDraft, StoredDomainEvent } from "@sixb/core/internal/events"
import { EventsRuntime } from "@sixb/core/internal/events"
import type { ObjectStorage, RulesStorage, TimeseriesStorage } from "@sixb/core/storage"
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
    const worker = track(
      new RulesWorker(
        createRuntime({
          events,
          storage: createStorage({ rules }),
        })
      )
    )
    await worker.start()

    await events.append({
      events: [objectUpdatedEvent("posted")],
    })
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

    await events.append({
      events: [objectUpdatedEvent("posted")],
    })
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
      const worker = track(
        new RulesWorker(
          createRuntime({
            events,
            storage: createStorage({ objects: new ThrowOnceObjectStorage() }),
          })
        )
      )
      await worker.start()

      await events.append({
        events: [objectUpdatedEvent("posted")],
      })
      await waitFor(() => errors.length === 1)

      await events.append({
        events: [objectUpdatedEvent("posted", "tx-2")],
      })
      await worker.stop()

      expect(String(errors[0]?.[0])).toContain("[SixbRulesWorker] Evaluation failed:")
      expect(await ruleEventTypes(events)).toEqual(["rule.triggered"])
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

function objectUpdatedEvent(status: string, primaryId = "tx-1"): EventDraft {
  return {
    type: "object.updated",
    payload: {
      objectTypeId: "transaction",
      primaryId,
      properties: { status },
      propertyChanges: {},
    },
  }
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
