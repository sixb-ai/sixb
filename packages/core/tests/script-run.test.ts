import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  defineWorkflow,
  defineWorkflowStep,
  prop,
  type ScriptContext,
  SixbHost,
} from "../src"
import type { Broker } from "../src/broker"
import { createScriptScope } from "../src/execution/scopes"
import type { Queues } from "../src/queues"
import { bindScript } from "../src/runtime/script"
import { InMemoryStorage } from "../src/storage"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const projectId = "script-run"

const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("email", "string", { required: true }),
  ],
})

const noop = defineWorkflowStep("noop")
  .input({})
  .output({})
  .run(async () => ({}))
const reindex = defineWorkflow("reindex").input({}).then(noop)

function createHost(
  input: {
    readonly broker?: (broker: Broker) => Broker
    readonly queues?: Queues
    readonly storage?: InMemoryStorage
    readonly onError?: (error: unknown) => void
  } = {}
) {
  const deps = createTestRuntimeDeps()
  return new SixbHost({
    id: projectId,
    ontology: [Customer],
    workflows: [reindex],
    ...deps,
    broker: input.broker ? input.broker(deps.broker) : deps.broker,
    queues: input.queues ?? deps.queues,
    storage: input.storage ?? deps.storage,
    ...(input.onError ? { onError: input.onError } : {}),
  })
}

/** The same provider, declared as reaching every process, as Redis or BullMQ would. */
function shared<T extends Broker | Queues>(provider: T): T {
  return new Proxy(provider, {
    get(target, property) {
      if (property === "scope") return "shared"
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function run(host: SixbHost, main: (context: ScriptContext) => unknown, args: string[] = []) {
  return bindScript(host, "scripts/fix-customers.ts").run({
    main,
    args,
    signal: new AbortController().signal,
  })
}

const artifactUpdate = { artifactId: "art_1", version: 2, revision: 1, frozen: false }

const upsertCustomer = async ({ sixb }: ScriptContext) => {
  await sixb.objects(Customer).upsert({ properties: { id: "c1", email: "a@example.com" } })
}

async function pendingEvents(host: SixbHost): Promise<number> {
  return (await host.storage.ontology.outbox.summarize({ projectId })).pendingCount
}

describe("bindScript", () => {
  test("writes with full access and records the script as the commit's execution", async () => {
    const host = createHost()
    let received: readonly string[] = []

    await run(
      host,
      async ({ sixb, args }) => {
        received = args
        await sixb.objects(Customer).upsert({ properties: { id: "c1", email: "a@example.com" } })
      },
      ["--dry-run", "2026-01-01"]
    )

    expect(received).toEqual(["--dry-run", "2026-01-01"])
    const [commit] = (await host.storage.ontology.commits.list({ projectId })).commits
    if (!commit) throw new Error("Expected the script's commit")
    const execution = await host.storage.executions.getById({ projectId, id: commit.executionId })
    expect(execution).toMatchObject({
      executor: { type: "script" },
      source: { type: "script", path: "scripts/fix-customers.ts" },
      authorizationRef: { type: "script" },
    })
    expect(execution?.requestedBy).toBeUndefined()
  })

  test("refuses a module whose default export is not a function", async () => {
    const error = await bindScript(createHost(), "scripts/fix-customers.ts")
      .run({ main: { not: "a function" }, args: [], signal: new AbortController().signal })
      .catch((caught: unknown) => caught)

    expect(String(error)).toContain(
      "scripts/fix-customers.ts must export a function as its default export"
    )
  })

  test("refuses a path outside the project", () => {
    for (const path of ["../fix.ts", "/tmp/fix.ts", "scripts/../fix.ts", "scripts\\fix.ts", ""]) {
      expect(() => createScriptScope({ projectId, path })).toThrow(
        "must be relative to the project"
      )
    }
  })

  // Guard proof: remove `this.committedFacts.relinquish()` from `enterScriptProcess`, and the
  // final drain in `closeBroker()` publishes the row, so the pending count drops to 0.
  test("leaves its events in the outbox when the broker lives in another process", async () => {
    const host = createHost()

    await run(host, upsertCustomer)
    await host.closeBroker()

    expect(await pendingEvents(host)).toBe(1)
  })

  // Guard proof: bind the script after the module loads in `sixb run`, as it first did, and a
  // script that fails to load closes a host that drains the other process's row.
  test("leaves the outbox alone from the moment it is bound, even if it never runs", async () => {
    const storage = new InMemoryStorage()
    await run(createHost({ storage }), upsertCustomer)

    const second = createHost({ storage })
    bindScript(second, "scripts/typo.ts")
    await second.closeBroker()

    expect(await pendingEvents(second)).toBe(1)
  })

  // Guard proof: drop the `events` override in `enterScriptProcess`, and the append succeeds into
  // a broker no other process reads.
  test("refuses events nobody would receive, and reports those emitted after work succeeded", async () => {
    const failures: unknown[] = []
    const host = createHost({ onError: (error) => failures.push(error) })

    const error = await run(host, ({ sixb }: ScriptContext) =>
      sixb.events.append({ events: [{ type: "artifact.updated", payload: artifactUpdate }] })
    ).catch((caught: unknown) => caught)

    expect(String(error)).toContain("A script cannot append events on this project's broker")
    expect(failures).toEqual([])

    await run(host, ({ sixb }: ScriptContext) =>
      sixb.events.emit(
        { events: [{ type: "artifact.updated", payload: artifactUpdate }] },
        { source: "ScriptRunTest" }
      )
    )
    expect(failures).toHaveLength(1)
    expect(String(failures[0])).toContain("A script cannot append events")
  })

  test("publishes its own events when the broker is shared", async () => {
    const host = createHost({ broker: shared })

    await run(host, async ({ sixb }) => {
      await sixb.objects(Customer).upsert({ properties: { id: "c1", email: "a@example.com" } })
    })
    await host.closeBroker()

    expect(await pendingEvents(host)).toBe(0)
  })

  // Guard proof: drop the `queues` override in `SixbHost.withScope`, and the workflow is queued in
  // this process's memory, where nothing will ever claim it.
  test("refuses to start work on queues only one process can claim", async () => {
    const host = createHost()

    const error = await run(host, ({ sixb }: ScriptContext) =>
      sixb.workflows.request(reindex, { input: {} })
    ).catch((caught: unknown) => caught)

    expect(String(error)).toContain("A script cannot start work on this project's queues")
  })

  // Guard proof: decide the override per execution again, and the action's own scope queues the
  // workflow in this process's memory.
  test("refuses those queues to everything the script process runs, not only the script", async () => {
    const host = createHost()
    bindScript(host, "scripts/fix-customers.ts")

    const error = await createTestSixb(host)
      .workflows.request(reindex, { input: {} })
      .catch((caught: unknown) => caught)

    expect(String(error)).toContain("A script cannot start work on this project's queues")
  })

  test("starts work on shared queues, and processes without a script keep process queues", async () => {
    const queued = async (queues: Queues) =>
      (await queues.workflows.claim({ projectId, workerId: "test" })).length

    // Production: Redis and BullMQ reach every process.
    const deps = createTestRuntimeDeps()
    const host = createHost({ broker: shared, queues: shared(deps.queues) })
    await run(host, ({ sixb }: ScriptContext) => sixb.workflows.request(reindex, { input: {} }))
    expect(await queued(deps.queues)).toBe(1)

    const local = createHost()
    await createTestSixb(local).workflows.request(reindex, { input: {} })
    expect(await queued(local.queues)).toBe(1)
  })
})
