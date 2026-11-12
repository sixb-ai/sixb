import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  col,
  defineDataset,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type LakeMaintenanceOptions,
  type ModelCatalogInput,
  SixbHost,
} from "@sixb/core"
import type { LakeMaintenance } from "@sixb/core/lake-storage"
import { SixbCliError } from "../src/lib/errors"
import {
  agentRuntimeRequired,
  assertWorkerInputs,
  createWorkerForType,
  omittedWorkerWarnings,
  resolveRegisteredWorkerTypes,
} from "../src/lib/worker-registry"

describe("assertWorkerInputs", () => {
  const originalOrigin = process.env.SIXB_API_PUBLIC_ORIGIN

  beforeEach(() => {
    delete process.env.SIXB_API_PUBLIC_ORIGIN
  })

  afterEach(() => {
    if (originalOrigin === undefined) {
      delete process.env.SIXB_API_PUBLIC_ORIGIN
    } else {
      process.env.SIXB_API_PUBLIC_ORIGIN = originalOrigin
    }
  })

  test("passes when every worker can be constructed", () => {
    expect(() =>
      assertWorkerInputs({
        agentApiRequired: true,
        workerTypes: ["sync", "pipeline", "agent"],
        options: { agentApiBaseUrl: "http://localhost:3002" },
        autoSelected: true,
      })
    ).not.toThrow()
  })

  test("passes when the requirement is met by the environment instead of the flag", () => {
    process.env.SIXB_API_PUBLIC_ORIGIN = "http://localhost:3002"

    expect(() =>
      assertWorkerInputs({
        agentApiRequired: true,
        workerTypes: ["agent"],
        options: {},
        autoSelected: false,
      })
    ).not.toThrow()
  })

  test("refuses an origin the browser roles would refuse, at the same moment they would", () => {
    // `sixb api` has always rejected a bare host. The agent worker used to accept it and
    // fail at its first request instead, so one `SIXB_API_PUBLIC_ORIGIN` could stop one
    // role at startup and start another. Both now read the same definition.
    process.env.SIXB_API_PUBLIC_ORIGIN = "api.example.com"

    expect(() =>
      assertWorkerInputs({
        agentApiRequired: true,
        workerTypes: ["agent"],
        options: {},
        autoSelected: false,
      })
    ).toThrow("Invalid API public origin")
  })

  test("refuses a full URL where an origin is expected", () => {
    expect(() =>
      assertWorkerInputs({
        agentApiRequired: true,
        workerTypes: ["agent"],
        options: { agentApiBaseUrl: "https://api.example.com/api" },
        autoSelected: false,
      })
    ).toThrow("must be an origin")
  })

  test("names what it took down, and how to proceed without it", () => {
    // The whole group refusing is correct: five of six workers running means agent jobs
    // pile up in a queue nobody claims, which looks exactly like an idle system. What was
    // missing is that the operator never asked for an agent worker — auto-discovery did.
    const failure = expectFailure(() =>
      assertWorkerInputs({
        agentApiRequired: true,
        workerTypes: ["sync", "pipeline", "agent"],
        options: {},
        autoSelected: true,
      })
    )

    expect(failure.message).toContain("agent requires --api-public-origin")
    expect(failure.message).toContain("No worker started, including the 2 that were ready")
    expect(failure.message).toContain("(sync, pipeline)")
    // The way forward is a remediation, so the terminal can give it its own place.
    expect(failure.remediation).toContain("`sixb worker-group sync pipeline`")
  })

  test("offers no escape hatch when the operator named the workers", () => {
    const failure = expectFailure(() =>
      assertWorkerInputs({
        agentApiRequired: true,
        workerTypes: ["sync", "agent"],
        options: {},
        autoSelected: false,
      })
    )

    expect(failure.message).toContain("agent requires --api-public-origin")
    // Someone who typed `sixb worker-group sync agent` asked for the agent worker.
    // Suggesting they drop it would be answering a question they did not ask.
    expect(failure.remediation).toBeUndefined()
  })

  test("ignores an unknown worker type, which the type resolver already rejects", () => {
    // `resolveWorkerTypeToStart` runs first and refuses unknown names with the list of
    // valid ones. Repeating that check here would give the same mistake two messages.
    expect(() =>
      assertWorkerInputs({
        agentApiRequired: true,
        workerTypes: ["not-a-worker"],
        options: {},
        autoSelected: false,
      })
    ).not.toThrow()
  })
})

function expectFailure(run: () => void): SixbCliError {
  try {
    run()
  } catch (error) {
    if (error instanceof SixbCliError) return error
    throw error
  }
  throw new Error("Expected the call to throw a SixbCliError.")
}

const accountingOnlyModels: Record<string, ModelCatalogInput> = {
  embedding: {
    embedding: [
      {
        providerId: "test",
        modelId: "embedding",
        definition: {
          kind: "embedding",
          providerId: "test",
          modelId: "embedding",
          dimensions: 2,
        },
        embed: async () => ({ vectors: [[1, 0]] }),
      },
    ],
  },
  decision: {
    decision: [
      {
        providerId: "test",
        modelId: "decision",
        definition: {
          kind: "decision",
          providerId: "test",
          modelId: "decision",
          capabilities: { questions: ["probability"] },
        },
        evaluate: async () => ({ output: { ok: { probability: 1 } } }),
      },
    ],
  },
}

for (const [kind, models] of Object.entries(accountingOnlyModels)) {
  test(`${kind}-only projects start accounting recovery without an API origin`, async () => {
    // Removal proof: require an origin unconditionally in workerFactories.agent.
    const host = new SixbHost({
      id: `${kind}s`,
      ontology: [],
      models,
      storage: new InMemoryStorage(),
      broker: new InMemoryBroker(),
      queues: new InMemoryQueues(),
      blobStorage: new InMemoryBlobStorage(),
      lakeStorage: new InMemoryLakeStorage(),
    })
    expect(resolveRegisteredWorkerTypes(host)).toContain("agent")
    expect(() =>
      assertWorkerInputs({
        agentApiRequired: agentRuntimeRequired(host.definitions),
        workerTypes: ["agent"],
        options: {},
        autoSelected: true,
      })
    ).not.toThrow()
    const worker = createWorkerForType(host, "agent")
    await worker.start()
    await worker.stop()
  })
}

for (const capability of ["aiUsage", "aiCosts", "aiLimits"] as const) {
  test(`does not select recovery when storage lacks ${capability}`, () => {
    const storage = new InMemoryStorage()
    const host = new SixbHost({
      id: "no-accounting",
      ontology: [],
      storage: {
        ...storage,
        [capability]: undefined,
        ping: () => storage.ping(),
        transaction: storage.transaction.bind(storage),
      },
      broker: new InMemoryBroker(),
      queues: new InMemoryQueues(),
      blobStorage: new InMemoryBlobStorage(),
      lakeStorage: new InMemoryLakeStorage(),
    })
    expect(resolveRegisteredWorkerTypes(host)).not.toContain("agent")
  })
}

describe("lake retention", () => {
  class MaintainedLakeStorage extends InMemoryLakeStorage {
    readonly maintenance: LakeMaintenance = {
      applyRetention: async () => {
        throw new Error("not run here")
      },
      describeStorage: async () => [],
    }
  }

  const rooms = defineDataset("raw.rooms", { schema: [col("id", "string")] })

  function host(lakeMaintenance?: LakeMaintenanceOptions) {
    return new SixbHost({
      id: "lake",
      ontology: [],
      datasets: [rooms],
      storage: new InMemoryStorage(),
      broker: new InMemoryBroker(),
      queues: new InMemoryQueues(),
      blobStorage: new InMemoryBlobStorage(),
      lakeStorage: new MaintainedLakeStorage(),
      lakeMaintenance,
    })
  }

  // Reproduce: drop `lake` from resolveRegisteredWorkerTypes.
  test("selects the lake worker for a project with datasets, and no sync worker", async () => {
    const sixb = host()
    const types = resolveRegisteredWorkerTypes(sixb)

    expect(types).toContain("lake")
    expect(types).not.toContain("sync")

    const worker = createWorkerForType(sixb, "lake")
    await worker.start()
    await worker.stop()
  })

  test("selects no lake worker when lake retention is off", () => {
    expect(resolveRegisteredWorkerTypes(host({ enabled: false }))).not.toContain("lake")
  })

  test("runs the lake worker at the concurrency it was given", () => {
    const worker = createWorkerForType(host(), "lake", { workerConcurrency: { lake: 3 } })

    expect(worker.concurrency).toBe(3)
  })

  // Reproduce: return [] from omittedWorkerWarnings in lib/worker-registry.ts.
  test("warns about a worker list that leaves the lake worker out", () => {
    expect(omittedWorkerWarnings(host(), ["pipeline"])).toEqual([
      expect.stringContaining("Lake cleanup needs a lake worker"),
    ])
  })

  test("warns about nothing when the list has it, or nothing needs it", () => {
    expect(omittedWorkerWarnings(host(), ["pipeline", "lake"])).toEqual([])
    expect(omittedWorkerWarnings(host({ enabled: false }), ["pipeline"])).toEqual([])
  })
})

describe("dataset ingestion", () => {
  const people = defineDataset("raw.people", { schema: [col("id", "string")], primaryKey: "id" })

  const canIngest = () =>
    new SixbHost({
      id: "ingest",
      ontology: [],
      datasets: [people],
      storage: new InMemoryStorage(),
      broker: new InMemoryBroker(),
      queues: new InMemoryQueues(),
      blobStorage: new InMemoryBlobStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      lakeMaintenance: { enabled: false },
    })

  // Reproduce: leave the ingest runtime out of lakeWorkerRequired in worker-registry.ts.
  test("selects the lake worker for a project that can ingest, without syncs or retention", () => {
    expect(resolveRegisteredWorkerTypes(canIngest())).toContain("lake")
  })

  // Reproduce: drop the ingest warning from omittedWorkerWarnings in worker-registry.ts.
  test("warns that ingested changes wait when the list leaves the lake worker out", () => {
    expect(omittedWorkerWarnings(canIngest(), ["pipeline"])).toEqual([
      expect.stringContaining("Ingested changes need a lake worker"),
    ])
  })
})

describe("renders", () => {
  /** A project with nothing to run but, with `sandboxes`, documents to print. */
  function host(sandboxes: boolean) {
    return new SixbHost({
      id: "renders",
      ontology: [],
      storage: new InMemoryStorage(),
      queues: new InMemoryQueues(),
      broker: new InMemoryBroker(),
      blobStorage: new InMemoryBlobStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      lakeMaintenance: { enabled: false },
      ...(sandboxes
        ? {
            sandboxes: {
              supportsRequestCredentials: true,
              create: async () => {
                throw new Error("Not opened here.")
              },
            },
          }
        : {}),
    })
  }

  // Reproduce: drop `render` from resolveRegisteredWorkerTypes.
  test("selects the render worker for a project with sandboxes, where documents print", () => {
    expect(resolveRegisteredWorkerTypes(host(true))).toContain("render")
    expect(resolveRegisteredWorkerTypes(host(false))).not.toContain("render")
    expect(
      createWorkerForType(host(true), "render", { workerConcurrency: { render: 3 } }).concurrency
    ).toBe(3)
  })

  test("warns about a worker list that leaves the render worker out", () => {
    expect(omittedWorkerWarnings(host(true), ["agent"])).toEqual([
      expect.stringContaining("Documents print to PDF in a render worker"),
    ])
    expect(omittedWorkerWarnings(host(true), ["agent", "render"])).toEqual([])
    expect(omittedWorkerWarnings(host(false), ["agent"])).toEqual([])
  })
})
