import { describe, expect, test } from "bun:test"
import { defineObjectType, link, prop, Sixb } from "../src"
import type { ActionReadObjectSetSource } from "../src/actions"
import {
  ActionReadRecorder,
  commitActionEdits,
  createActionReadFacade,
  findActionEditCommit,
} from "../src/actions"
import { recordEdits } from "../src/actions/worker"
import type { EditBatch } from "../src/edits"
import { lowerEditBatch } from "../src/edits"
import { createLinkScopeFingerprint } from "../src/materializer"
import { getOntologyMutationRuntime } from "../src/runtime/internal"
import type { ObjectRow, Storage } from "../src/storage"
import { storageTransactionError } from "../src/storage/errors"
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
  const sixb = new Sixb({ id: "edits-tests", ontology: ONTOLOGY, ...deps })
  return { deps, sixb }
}

type EditsRuntime = ReturnType<typeof createRuntime>["sixb"]

async function startActionRun(sixb: EditsRuntime, runId: string, actionId = "markPaid") {
  const actionRuns = sixb.storage.actionRuns
  if (!actionRuns) throw new Error("Expected action run storage in the test runtime.")
  await actionRuns.queue({
    projectId: sixb.id,
    id: runId,
    actionId,
    subject: { kind: "none" },
    params: {},
    idempotencyKey: `action:${sixb.id}:${runId}`,
  })
  await actionRuns.start({ projectId: sixb.id, id: runId })
}

function commit(
  sixb: EditsRuntime,
  input: {
    readonly runId: string
    readonly batch: EditBatch
    readonly actionId?: string
    readonly dependencies?: Parameters<typeof commitActionEdits>[0]["dependencies"]
  }
) {
  return commitActionEdits({
    mutations: getOntologyMutationRuntime(sixb),
    projectId: sixb.id,
    runId: input.runId,
    actionId: input.actionId ?? "markPaid",
    batch: input.batch,
    ...(input.dependencies !== undefined ? { dependencies: input.dependencies } : {}),
  })
}

async function seedInvoice(sixb: EditsRuntime, overrides: Record<string, unknown> = {}) {
  return sixb.upsertObject("Invoice", {
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
    const { sixb } = createRuntime()
    await seedInvoice(sixb)
    await startActionRun(sixb, "act_commit")

    const batch = await recordEdits({ runId: "act_commit" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })
    const result = await commit(sixb, { runId: "act_commit", batch })

    expect(result.created).toBe(true)
    expect(result.outcomes).toMatchObject([{ id: "op:0", ok: true, authority: "changed" }])
    expect(result.changes.objects.map((change) => change.kind)).toEqual(["updated"])
    expect(result.committedAt).toBeInstanceOf(Date)

    const record = await sixb.storage.ontology.commits.getById({
      projectId: sixb.id,
      id: result.commitId,
    })
    expect(record?.origin).toEqual({ kind: "action", actionId: "markPaid", runId: "act_commit" })
    expect(record?.intent).toEqual({ kind: "edit", mode: "atomic", operationCount: 1 })

    const stored = await sixb.storage.objects.getByPrimaryId({
      projectId: sixb.id,
      objectTypeId: "Invoice",
      primaryId: "inv_1",
    })
    expect(stored?.properties.status).toBe("paid")
    expect(stored?.lastCommitId).toBe(result.commitId)
  })

  test("replays an existing commit for the same run and rejects divergent intent", async () => {
    const { sixb } = createRuntime()
    await seedInvoice(sixb)
    await startActionRun(sixb, "act_replay")

    const batch = await recordEdits({ runId: "act_replay" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })
    const first = await commit(sixb, { runId: "act_replay", batch })
    const replay = await commit(sixb, { runId: "act_replay", batch })

    expect(replay.commitId).toBe(first.commitId)
    expect(replay.created).toBe(false)
    expect(replay.changes).toEqual(first.changes)

    const divergent = await recordEdits({ runId: "act_replay" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "void" })
    })
    await expect(commit(sixb, { runId: "act_replay", batch: divergent })).rejects.toHaveProperty(
      "code",
      "storage.conflict"
    )
  })

  test("resolves a resumed run by its exact origin without rerunning handlers", async () => {
    const { sixb } = createRuntime()
    await seedInvoice(sixb)
    await startActionRun(sixb, "act_resume")

    const batch = await recordEdits({ runId: "act_resume" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })
    const committed = await commit(sixb, { runId: "act_resume", batch })

    const resumed = await findActionEditCommit({
      storage: sixb.storage,
      projectId: sixb.id,
      runId: "act_resume",
    })
    expect(resumed?.commitId).toBe(committed.commitId)
    expect(resumed?.created).toBe(false)
    expect(resumed?.changes).toEqual(committed.changes)
    expect(resumed?.committedAt).toEqual(committed.committedAt)

    expect(
      await findActionEditCommit({
        storage: sixb.storage,
        projectId: sixb.id,
        runId: "act_unknown",
      })
    ).toBeNull()
  })

  test("refuses to mutate anything when the Action run identity does not match", async () => {
    const { sixb } = createRuntime()
    await seedInvoice(sixb)
    await startActionRun(sixb, "act_identity", "markPaid")

    const batch = await recordEdits({ runId: "act_identity" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })
    await expect(
      commit(sixb, { runId: "act_identity", actionId: "otherAction", batch })
    ).rejects.toThrow()

    const stored = await sixb.storage.objects.getByPrimaryId({
      projectId: sixb.id,
      objectTypeId: "Invoice",
      primaryId: "inv_1",
    })
    expect(stored?.properties.status).toBe("draft")
    const commits = await sixb.storage.ontology.commits.list({ projectId: sixb.id })
    expect(commits.commits.filter((record) => record.origin.kind === "action")).toEqual([])
  })

  test("fails the commit when an observed object revision is stale", async () => {
    const { sixb } = createRuntime()
    const seeded = await seedInvoice(sixb)
    await startActionRun(sixb, "act_stale")

    const batch = await recordEdits({ runId: "act_stale" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })
    await expect(
      commit(sixb, {
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
    ).rejects.toHaveProperty("code", "storage.conflict")
  })

  test("fails the commit when an observed link scope changed", async () => {
    const { sixb } = createRuntime()
    await seedInvoice(sixb)
    await sixb.upsertObject("Customer", { id: "cus_1", name: "Ada" })
    await startActionRun(sixb, "act_scope")

    const batch = await recordEdits({ runId: "act_scope" }, ({ objects }) => {
      objects(Invoice)
        .byId("inv_1")
        .link(Invoice.l.customer, { objectTypeId: "Customer", primaryId: "cus_1" })
    })
    await expect(
      commit(sixb, {
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
    ).rejects.toHaveProperty("code", "storage.conflict")
  })

  test("accepts a commit whose observed empty scope still matches", async () => {
    const { sixb } = createRuntime()
    await seedInvoice(sixb)
    await sixb.upsertObject("Customer", { id: "cus_1", name: "Ada" })
    await startActionRun(sixb, "act_empty_scope")

    const batch = await recordEdits({ runId: "act_empty_scope" }, ({ objects }) => {
      objects(Invoice)
        .byId("inv_1")
        .link(Invoice.l.customer, { objectTypeId: "Customer", primaryId: "cus_1" })
    })
    const result = await commit(sixb, {
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
            throw storageTransactionError("forced serialization failure", {
              reason: "serialization_failure",
            })
          }, options as never)
      },
    }) as unknown as Storage
    const sixb = new Sixb({ id: "edits-tests", ontology: ONTOLOGY, ...deps, storage })

    await sixb.upsertObject("Invoice", { id: "inv_1", amount: 100, status: "draft" })
    await startActionRun(sixb, "act_retry")

    let handlerRuns = 0
    const batch = await recordEdits({ runId: "act_retry" }, ({ objects }) => {
      handlerRuns += 1
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })

    armed = true
    const result = await commit(sixb, { runId: "act_retry", batch })

    expect(handlerRuns).toBe(1)
    expect(result.created).toBe(true)
    expect(
      (
        await deps.storage.objects.getByPrimaryId({
          projectId: sixb.id,
          objectTypeId: "Invoice",
          primaryId: "inv_1",
        })
      )?.properties.status
    ).toBe("paid")
  })
})

describe("Action read dependency capture", () => {
  function createFacade(sixb: EditsRuntime) {
    const reads = new ActionReadRecorder()
    const facade = createActionReadFacade(
      (objectType) =>
        (sixb as unknown as { objects(type: unknown): ActionReadObjectSetSource }).objects(
          objectType
        ),
      {
        recorder: reads,
        resolveLinkIds: (objectTypeId) =>
          sixb.ontology.resolveObjectType(objectTypeId).links.map((definition) => definition.id),
      }
    )
    return { facade, reads }
  }

  test("records concrete object reads, exact absence, and the first observation", async () => {
    const { sixb } = createRuntime()
    const seeded = await seedInvoice(sixb)
    const { facade, reads } = createFacade(sixb)

    await facade.objects(Invoice).byId("inv_1").get()
    await facade.objects(Invoice).get("inv_missing")
    await sixb.upsertObject("Invoice", { id: "inv_1", amount: 100, status: "paid" })
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

  test("records complete link scopes, including the ones a listing found empty", async () => {
    const { sixb, deps } = createRuntime()
    await seedInvoice(sixb)
    await sixb.upsertObject("Customer", { id: "cus_1", name: "Ada" })
    await sixb.upsertLink("Invoice", "inv_1", "customer", {
      targetTypeId: "Customer",
      targetId: "cus_1",
    })
    const { facade, reads } = createFacade(sixb)

    await facade.objects(Invoice).byId("inv_1").listLinks()

    const rows = await deps.storage.objects.listLinks({
      projectId: sixb.id,
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
    const { sixb } = createRuntime()
    await sixb.upsertObject("RecurringInvoice", {
      id: "inv_r1",
      amount: 100,
      status: "draft",
      cadence: "monthly",
    })
    const { facade, reads } = createFacade(sixb)

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
    const { sixb } = createRuntime()
    await seedInvoice(sixb)
    const { facade, reads } = createFacade(sixb)

    await facade.objects(Invoice).byId("inv_1").listLinks(Invoice.l.reviewers)

    expect(reads.dependencies().linkScopes.map((scope) => scope.linkId)).toEqual(["reviewers"])
  })

  test("captured dependencies protect the commit that follows them", async () => {
    const { sixb } = createRuntime()
    await seedInvoice(sixb)
    await startActionRun(sixb, "act_capture")
    const { facade, reads } = createFacade(sixb)

    const observed = (await facade.objects(Invoice).byId("inv_1").get()) as ObjectRow | null
    expect(observed?.properties.status).toBe("draft")

    // A concurrent runtime write moves the object past the revision the handler observed.
    await sixb.upsertObject("Invoice", { id: "inv_1", amount: 100, status: "void" })

    const batch = await recordEdits({ runId: "act_capture" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })
    await expect(
      commit(sixb, { runId: "act_capture", batch, dependencies: reads.dependencies() })
    ).rejects.toHaveProperty("code", "storage.conflict")
  })
})
