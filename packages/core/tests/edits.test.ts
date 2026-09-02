import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  link,
  MaterializationConflictError,
  type OntologySource,
  prop,
  SixbHost,
} from "../src"
import {
  ActionReadRecorder,
  commitActionEdits,
  createActionReadFacade,
  findActionEditCommit,
} from "../src/actions"
import { recordEdits } from "../src/actions/worker"
import type { EditBatch } from "../src/edits"
import { lowerEditBatch } from "../src/edits"
import { bindDurablePrimitiveExecution } from "../src/execution/primitive"
import { createLinkScopeFingerprint } from "../src/materializer"
import type { ObjectRow, Storage, TimeseriesHistoryBatchResult } from "../src/storage"
import { StorageTransactionError } from "../src/storage"
import { createTestSixb, queueTestActionRun } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("amount", "double", { required: true }),
    prop("status", "string", { required: true }),
    prop("note", "string", { nullable: true }),
    prop("paidAt", "timestamp"),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
  links: [
    link("customer", Customer, { cardinality: "one" }),
    link("reviewers", Customer, { cardinality: "many" }),
  ],
})

/** Inherits `Invoice`'s links, which only the Ontology registry resolves. */
const RecurringInvoice = defineObjectType({
  id: "RecurringInvoice",
  name: "Recurring invoice",
  extends: Invoice,
  properties: [prop("cadence", "string", { required: true })],
})

const ONTOLOGY = [Invoice, Customer, RecurringInvoice] as const

function createRuntime() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost<readonly OntologySource[]>({
    id: "edits-tests",
    ontology: ONTOLOGY,
    ...deps,
  })
  return { deps, host, sixb: createTestSixb(host) }
}

type EditsRuntime = ReturnType<typeof createRuntime>["sixb"]
type EditsHost = ReturnType<typeof createRuntime>["host"]

async function startActionRun(host: EditsHost, runId: string, actionId = "markPaid") {
  const actionRuns = host.storage.actionRuns
  if (!actionRuns) throw new Error("Expected action run storage in the test runtime.")
  await queueTestActionRun(host.storage, {
    projectId: host.id,
    id: runId,
    actionId,
    subject: { kind: "none" },
    params: {},
    idempotencyKey: `action:${host.id}:${runId}`,
  })
  await actionRuns.start({ projectId: host.id, id: runId })
}

async function commit(
  host: EditsHost,
  input: {
    readonly runId: string
    readonly batch: EditBatch
    readonly actionId?: string
    readonly dependencies?: Parameters<typeof commitActionEdits>[0]["dependencies"]
  }
) {
  const run = await host.storage.actionRuns?.getById({ projectId: host.id, id: input.runId })
  if (!run) throw new Error(`Expected Action run '${input.runId}'.`)
  const execution = await host.storage.executions.getById({
    projectId: host.id,
    id: run.executionId,
  })
  if (!execution) throw new Error(`Expected Action execution '${run.executionId}'.`)
  const primitive = {
    kind: "action" as const,
    id: input.actionId ?? "markPaid",
    runId: input.runId,
  }
  return commitActionEdits({
    mutations: bindDurablePrimitiveExecution(host, { execution, primitive }).ontologyMutations,
    projectId: host.id,
    runId: input.runId,
    actionId: input.actionId ?? "markPaid",
    batch: input.batch,
    ...(input.dependencies !== undefined ? { dependencies: input.dependencies } : {}),
  })
}

async function seedInvoice(sixb: EditsRuntime, overrides: Record<string, unknown> = {}) {
  return sixb.objects.upsert("Invoice", {
    id: "inv_1",
    amount: 100,
    status: "draft",
    ...overrides,
  })
}

describe("EditBatch authoring contract", () => {
  test("records one final wire shape with ordered, repeated operations", async () => {
    const batch = await recordEdits({ runId: "act_1" }, ({ objects }) => {
      const invoice = objects(Invoice).byId("inv_1")
      invoice.update({ status: "sent" })
      invoice.update({ status: "paid", paidAt: new Date("2026-06-01T10:00:00.000Z") })
      invoice.unset("note")
      invoice.reset("amount")
      invoice.link(Invoice.l.customer, { objectTypeId: "Customer", primaryId: "cus_1" })
      invoice.unlink(Invoice.l.reviewers, { objectTypeId: "Customer", primaryId: "cus_2" })
      invoice.resetLink(Invoice.l.customer, { objectTypeId: "Customer", primaryId: "cus_1" })
      invoice.delete()
      invoice.restore()
    })

    expect(batch.operations.map((operation) => operation.kind)).toEqual([
      "object.update",
      "object.update",
      "object.unset",
      "object.reset",
      "link.upsert",
      "link.delete",
      "link.reset",
      "object.delete",
      "object.restore",
    ])
    expect(batch.operations[1]).toEqual({
      kind: "object.update",
      objectTypeId: "Invoice",
      primaryId: "inv_1",
      properties: { status: "paid", paidAt: "2026-06-01T10:00:00.000Z" },
    })
  })

  test("keeps identity out of created authority properties", async () => {
    const batch = await recordEdits({ runId: "act_1" }, ({ objects }) => {
      objects(Invoice).create({ id: "inv_new", amount: 12, status: "draft" })
    })

    expect(batch.operations[0]).toEqual({
      kind: "object.create",
      objectTypeId: "Invoice",
      primaryId: "inv_new",
      properties: { amount: 12, status: "draft" },
    })
  })

  test("derives a stable primary id when a create omits one", async () => {
    const primaryId = (batch: EditBatch) =>
      batch.operations[0]?.kind === "object.create" ? batch.operations[0].primaryId : undefined
    const record = (runId: string) =>
      recordEdits({ runId }, ({ objects }) => {
        objects(Invoice).create({ amount: 1, status: "draft" })
      })

    const first = await record("act_1")
    const replay = await record("act_1")
    const otherRun = await record("act_2")

    expect(primaryId(first)).toBe(primaryId(replay))
    expect(primaryId(first)).not.toBe(primaryId(otherRun))
  })

  test("rejects edits the managed authority model cannot express", async () => {
    const reject = (record: Parameters<typeof recordEdits>[1]) =>
      expect(recordEdits({ runId: "act_1" }, record)).rejects.toThrow()

    await reject(({ objects }) => {
      objects(Invoice)
        .byId("inv_1")
        .update({ id: "inv_2" } as never)
    })
    await reject(({ objects }) => {
      objects(Invoice)
        .byId("inv_1")
        .unset("id" as never)
    })
    await reject(({ objects }) => {
      objects(Invoice)
        .byId("inv_1")
        .reset("temperature" as never)
    })
    await reject(({ objects }) => {
      objects(Invoice)
        .byId("inv_1")
        .update({ temperature: 20 } as never)
    })
    await reject(({ objects }) => {
      objects(Invoice)
        .byId("inv_1")
        .update({ bogus: true } as never)
    })
    await reject(({ objects }) => {
      objects(Invoice).byId("inv_1").unset()
    })
  })
})

describe("EditBatch lowering", () => {
  test("lowers every authored operation onto the canonical materializer union", async () => {
    const batch = await recordEdits({ runId: "act_1" }, ({ objects }) => {
      const invoice = objects(Invoice).byId("inv_1")
      invoice.update({ status: "paid" })
      invoice.unset("note")
      invoice.reset("amount")
      invoice.restore()
      invoice.link(Invoice.l.customer, { objectTypeId: "Customer", primaryId: "cus_1" })
      invoice.resetLink(Invoice.l.customer, { objectTypeId: "Customer", primaryId: "cus_1" })
    })

    expect(lowerEditBatch(batch)).toEqual([
      {
        id: "op:0",
        kind: "object.patch",
        ref: { objectTypeId: "Invoice", primaryId: "inv_1" },
        set: { status: "paid" },
        unset: [],
        reset: [],
      },
      {
        id: "op:1",
        kind: "object.patch",
        ref: { objectTypeId: "Invoice", primaryId: "inv_1" },
        set: {},
        unset: ["note"],
        reset: [],
      },
      {
        id: "op:2",
        kind: "object.patch",
        ref: { objectTypeId: "Invoice", primaryId: "inv_1" },
        set: {},
        unset: [],
        reset: ["amount"],
      },
      {
        id: "op:3",
        kind: "object.restore",
        ref: { objectTypeId: "Invoice", primaryId: "inv_1" },
      },
      {
        id: "op:4",
        kind: "link.upsert",
        ref: {
          source: { objectTypeId: "Invoice", primaryId: "inv_1" },
          linkId: "customer",
          target: { objectTypeId: "Customer", primaryId: "cus_1" },
        },
      },
      {
        id: "op:5",
        kind: "link.reset",
        ref: {
          source: { objectTypeId: "Invoice", primaryId: "inv_1" },
          linkId: "customer",
          target: { objectTypeId: "Customer", primaryId: "cus_1" },
        },
      },
    ])
  })
})

describe("Action edit commits", () => {
  test("commits action-origin authority, effective state, and outbox facts together", async () => {
    const { host, sixb } = createRuntime()
    await seedInvoice(sixb)
    await startActionRun(host, "act_commit")

    const batch = await recordEdits({ runId: "act_commit" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })
    const result = await commit(host, { runId: "act_commit", batch })

    expect(result.created).toBe(true)
    expect(result.outcomes).toMatchObject([{ id: "op:0", ok: true, authority: "changed" }])
    expect(result.changes.objects.map((change) => change.kind)).toEqual(["updated"])
    expect(result.committedAt).toBeInstanceOf(Date)

    const record = await host.storage.ontology.commits.getById({
      projectId: sixb.execution.projectId,
      id: result.commitId,
    })
    expect(record?.origin).toEqual({ kind: "action", actionId: "markPaid", runId: "act_commit" })
    expect(record?.intent).toEqual({ kind: "edit", mode: "atomic", operationCount: 1 })

    const stored = await host.storage.objects.getByPrimaryId({
      projectId: sixb.execution.projectId,
      objectTypeId: "Invoice",
      primaryId: "inv_1",
    })
    expect(stored?.properties.status).toBe("paid")
    expect(stored?.lastCommitId).toBe(result.commitId)
  })

  test("replays an existing commit for the same run and rejects divergent intent", async () => {
    const { host, sixb } = createRuntime()
    await seedInvoice(sixb)
    await startActionRun(host, "act_replay")

    const batch = await recordEdits({ runId: "act_replay" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })
    const first = await commit(host, { runId: "act_replay", batch })
    const replay = await commit(host, { runId: "act_replay", batch })

    expect(replay.commitId).toBe(first.commitId)
    expect(replay.created).toBe(false)
    expect(replay.changes).toEqual(first.changes)

    const divergent = await recordEdits({ runId: "act_replay" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "void" })
    })
    await expect(commit(host, { runId: "act_replay", batch: divergent })).rejects.toBeInstanceOf(
      MaterializationConflictError
    )
  })

  test("resolves a resumed run by its exact origin without rerunning handlers", async () => {
    const { host, sixb } = createRuntime()
    await seedInvoice(sixb)
    await startActionRun(host, "act_resume")

    const batch = await recordEdits({ runId: "act_resume" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })
    const committed = await commit(host, { runId: "act_resume", batch })

    const resumed = await findActionEditCommit({
      storage: host.storage,
      projectId: sixb.execution.projectId,
      runId: "act_resume",
    })
    expect(resumed?.commitId).toBe(committed.commitId)
    expect(resumed?.created).toBe(false)
    expect(resumed?.changes).toEqual(committed.changes)
    expect(resumed?.committedAt).toEqual(committed.committedAt)

    expect(
      await findActionEditCommit({
        storage: host.storage,
        projectId: sixb.execution.projectId,
        runId: "act_unknown",
      })
    ).toBeNull()
  })

  test("refuses to mutate anything when the Action run identity does not match", async () => {
    const { host, sixb } = createRuntime()
    await seedInvoice(sixb)
    await startActionRun(host, "act_identity", "markPaid")

    const batch = await recordEdits({ runId: "act_identity" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })
    await expect(
      commit(host, { runId: "act_identity", actionId: "otherAction", batch })
    ).rejects.toThrow()

    const stored = await host.storage.objects.getByPrimaryId({
      projectId: sixb.execution.projectId,
      objectTypeId: "Invoice",
      primaryId: "inv_1",
    })
    expect(stored?.properties.status).toBe("draft")
    const commits = await host.storage.ontology.commits.list({
      projectId: sixb.execution.projectId,
    })
    expect(commits.commits.filter((record) => record.origin.kind === "action")).toEqual([])
  })

  test("fails the commit when an observed object revision is stale", async () => {
    const { host, sixb } = createRuntime()
    const seeded = await seedInvoice(sixb)
    await startActionRun(host, "act_stale")

    const batch = await recordEdits({ runId: "act_stale" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })
    await expect(
      commit(host, {
        runId: "act_stale",
        batch,
        dependencies: {
          objects: [
            {
              ref: { objectTypeId: "Invoice", primaryId: "inv_1" },
              exists: true,
              version: seeded.version,
              lastCommitId: "commit-that-never-existed",
            },
          ],
          links: [],
          linkScopes: [],
        },
      })
    ).rejects.toBeInstanceOf(MaterializationConflictError)
  })

  test("fails the commit when an observed link scope changed", async () => {
    const { host, sixb } = createRuntime()
    await seedInvoice(sixb)
    await sixb.objects.upsert("Customer", { id: "cus_1", name: "Ada" })
    await startActionRun(host, "act_scope")

    const batch = await recordEdits({ runId: "act_scope" }, ({ objects }) => {
      objects(Invoice)
        .byId("inv_1")
        .link(Invoice.l.customer, { objectTypeId: "Customer", primaryId: "cus_1" })
    })
    await expect(
      commit(host, {
        runId: "act_scope",
        batch,
        dependencies: {
          objects: [],
          links: [],
          linkScopes: [
            {
              source: { objectTypeId: "Invoice", primaryId: "inv_1" },
              linkId: "customer",
              fingerprint: "fingerprint-of-a-scope-that-never-existed",
            },
          ],
        },
      })
    ).rejects.toBeInstanceOf(MaterializationConflictError)
  })

  test("accepts a commit whose observed empty scope still matches", async () => {
    const { host, sixb } = createRuntime()
    await seedInvoice(sixb)
    await sixb.objects.upsert("Customer", { id: "cus_1", name: "Ada" })
    await startActionRun(host, "act_empty_scope")

    const batch = await recordEdits({ runId: "act_empty_scope" }, ({ objects }) => {
      objects(Invoice)
        .byId("inv_1")
        .link(Invoice.l.customer, { objectTypeId: "Customer", primaryId: "cus_1" })
    })
    const result = await commit(host, {
      runId: "act_empty_scope",
      batch,
      dependencies: {
        objects: [],
        links: [],
        linkScopes: [
          {
            source: { objectTypeId: "Invoice", primaryId: "inv_1" },
            linkId: "customer",
            fingerprint: createLinkScopeFingerprint([]),
          },
        ],
      },
    })

    expect(result.changes.links.map((change) => change.kind)).toEqual(["created"])
  })
})

describe("Action commit retries", () => {
  test("retries a serialization failure without rerunning the handler", async () => {
    const deps = createTestRuntimeDeps()
    let armed = false
    const storage = new Proxy(deps.storage, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver)
        return (run: (tx: Storage) => unknown, options?: unknown) =>
          target.transaction(async (tx) => {
            const result = await run(tx)
            if (!armed) return result
            armed = false
            throw new StorageTransactionError("forced serialization failure", {
              code: "serialization_failure",
            })
          }, options as never)
      },
    }) as unknown as Storage
    const host = new SixbHost<readonly OntologySource[]>({
      id: "edits-tests",
      ontology: ONTOLOGY,
      ...deps,
      storage,
    })
    const sixb = createTestSixb(host)

    await sixb.objects.upsert("Invoice", { id: "inv_1", amount: 100, status: "draft" })
    await startActionRun(host, "act_retry")

    let handlerRuns = 0
    const batch = await recordEdits({ runId: "act_retry" }, ({ objects }) => {
      handlerRuns += 1
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })

    armed = true
    const result = await commit(host, { runId: "act_retry", batch })

    expect(handlerRuns).toBe(1)
    expect(result.created).toBe(true)
    expect(
      (
        await deps.storage.objects.getByPrimaryId({
          projectId: sixb.execution.projectId,
          objectTypeId: "Invoice",
          primaryId: "inv_1",
        })
      )?.properties.status
    ).toBe("paid")
  })
})

describe("Action read dependency capture", () => {
  function createFacade(host: EditsHost, sixb: EditsRuntime) {
    const reads = new ActionReadRecorder()
    const facade = createActionReadFacade((objectType) => sixb.objects(objectType), {
      recorder: reads,
      resolveLinkIds: (objectTypeId) =>
        host.definitions.ontology
          .resolveObjectType(objectTypeId)
          .links.map((definition) => definition.id),
      telemetry: {
        resolveObjectType: (objectTypeId) => sixb.objects.resolveType(objectTypeId),
        getHistoryBatch: (input) => sixb.objects.getTelemetryHistoryBatch(input),
      },
    })
    return { facade, reads }
  }

  test("records concrete object reads, exact absence, and the first observation", async () => {
    const { host, sixb } = createRuntime()
    const seeded = await seedInvoice(sixb)
    const { facade, reads } = createFacade(host, sixb)

    await facade.objects(Invoice).byId("inv_1").get()
    await facade.objects(Invoice).get("inv_missing")
    await sixb.objects.upsert("Invoice", { id: "inv_1", amount: 100, status: "paid" })
    await facade.objects(Invoice).byId("inv_1").get()

    expect(reads.dependencies().objects).toMatchObject([
      {
        ref: { objectTypeId: "Invoice", primaryId: "inv_1" },
        exists: true,
        version: seeded.version,
        lastCommitId: seeded.lastCommitId,
      },
      { ref: { objectTypeId: "Invoice", primaryId: "inv_missing" }, exists: false },
    ])
  })

  test("reads telemetry batches without turning history into a commit dependency", async () => {
    const { host, sixb } = createRuntime()
    await seedInvoice(sixb)
    await sixb.objects(Invoice).appendTelemetryBatch([
      {
        id: "inv_1",
        properties: { temperature: 18 },
        at: new Date("2026-06-01T10:00:00.000Z"),
      },
      {
        id: "inv_1",
        properties: { temperature: 20 },
        at: new Date("2026-06-02T10:00:00.000Z"),
      },
    ])
    const { facade, reads } = createFacade(host, sixb)

    const histories = await facade.telemetry.historyBatch({
      series: [
        { objectId: "inv_1", property: Invoice.p.temperature },
        { objectId: "inv_1", property: Invoice.p.temperature },
      ],
      order: "desc",
      limitPerSeries: 1,
    })

    expect(histories.map((history) => history.points.map((point) => point.value))).toEqual([
      [20],
      [20],
    ])
    expect(reads.dependencies()).toEqual({ objects: [], links: [], linkScopes: [] })

    await expect(
      facade.telemetry.historyBatch({
        series: [
          {
            objectId: "inv_1",
            property: Invoice.p.status as unknown as typeof Invoice.p.temperature,
          },
        ],
      })
    ).rejects.toThrow("Property status is not telemetry-enabled")
  })

  test("rejects telemetry providers that break batch cardinality or position", async () => {
    const reads = new ActionReadRecorder()
    let providerResults: readonly TimeseriesHistoryBatchResult[] = []
    const facade = createActionReadFacade(
      () => {
        throw new Error("Object reads are not expected in this test.")
      },
      {
        recorder: reads,
        resolveLinkIds: () => [],
        telemetry: {
          resolveObjectType: () => Invoice,
          getHistoryBatch: async () => providerResults,
        },
      }
    )
    const input = {
      series: [{ objectId: "inv_1", property: Invoice.p.temperature }],
    } as const

    await expect(facade.telemetry.historyBatch(input)).rejects.toThrow(
      "returned 0 batch results for 1 requested series"
    )

    providerResults = [
      {
        objectTypeId: "Invoice",
        objectId: "inv_other",
        propertyId: "temperature",
        points: [],
      },
    ]
    await expect(facade.telemetry.historyBatch(input)).rejects.toThrow(
      "returned an unexpected series at batch index 0"
    )
  })

  test("records complete link scopes, including the ones a listing found empty", async () => {
    const { deps, host, sixb } = createRuntime()
    await seedInvoice(sixb)
    await sixb.objects.upsert("Customer", { id: "cus_1", name: "Ada" })
    await sixb.objects.upsertLink("Invoice", "inv_1", "customer", {
      targetTypeId: "Customer",
      targetId: "cus_1",
    })
    const { facade, reads } = createFacade(host, sixb)

    await facade.objects(Invoice).byId("inv_1").listLinks()

    const rows = await deps.storage.objects.listLinks({
      projectId: sixb.execution.projectId,
      objectTypeId: "Invoice",
      objectId: "inv_1",
      linkId: "customer",
    })
    const dependencies = reads.dependencies()
    expect(dependencies.linkScopes).toEqual([
      {
        source: { objectTypeId: "Invoice", primaryId: "inv_1" },
        linkId: "customer",
        fingerprint: createLinkScopeFingerprint(
          rows.map((row) => ({
            ref: {
              source: { objectTypeId: row.sourceTypeId, primaryId: row.sourceId },
              linkId: row.linkId,
              target: { objectTypeId: row.targetTypeId, primaryId: row.targetId },
            },
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
            lastCommitId: row.lastCommitId ?? "",
          }))
        ),
      },
      {
        source: { objectTypeId: "Invoice", primaryId: "inv_1" },
        linkId: "reviewers",
        fingerprint: createLinkScopeFingerprint([]),
      },
    ])
    expect(dependencies.links).toMatchObject([
      {
        ref: {
          source: { objectTypeId: "Invoice", primaryId: "inv_1" },
          linkId: "customer",
          target: { objectTypeId: "Customer", primaryId: "cus_1" },
        },
        exists: true,
        lastCommitId: rows[0]?.lastCommitId,
      },
    ])
  })

  test("records inherited link scopes an untargeted listing covered", async () => {
    const { host, sixb } = createRuntime()
    await sixb.objects.upsert("RecurringInvoice", {
      id: "inv_r1",
      amount: 100,
      status: "draft",
      cadence: "monthly",
    })
    const { facade, reads } = createFacade(host, sixb)

    await facade.objects(RecurringInvoice).byId("inv_r1").listLinks()

    // `customer` and `reviewers` are declared on Invoice, so the definition alone would omit them.
    expect(
      reads
        .dependencies()
        .linkScopes.map((scope) => scope.linkId)
        .sort()
    ).toEqual(["customer", "reviewers"])
  })

  test("scopes a targeted listing to the requested link only", async () => {
    const { host, sixb } = createRuntime()
    await seedInvoice(sixb)
    const { facade, reads } = createFacade(host, sixb)

    await facade.objects(Invoice).byId("inv_1").listLinks(Invoice.l.reviewers)

    expect(reads.dependencies().linkScopes.map((scope) => scope.linkId)).toEqual(["reviewers"])
  })

  test("captured dependencies protect the commit that follows them", async () => {
    const { host, sixb } = createRuntime()
    await seedInvoice(sixb)
    await startActionRun(host, "act_capture")
    const { facade, reads } = createFacade(host, sixb)

    const observed = (await facade.objects(Invoice).byId("inv_1").get()) as ObjectRow | null
    expect(observed?.properties.status).toBe("draft")

    // A concurrent runtime write moves the object past the revision the handler observed.
    await sixb.objects.upsert("Invoice", { id: "inv_1", amount: 100, status: "void" })

    const batch = await recordEdits({ runId: "act_capture" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })
    await expect(
      commit(host, { runId: "act_capture", batch, dependencies: reads.dependencies() })
    ).rejects.toBeInstanceOf(MaterializationConflictError)
  })
})
