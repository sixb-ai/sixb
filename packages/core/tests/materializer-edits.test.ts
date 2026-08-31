import { describe, expect, test } from "bun:test"
import { emptyGrantIndex } from "../src"
import { createTestingScope } from "../src/execution/scopes"
import { createEventId, MaterializationConflictError } from "../src/materializer"
import { InMemoryStorage, type Storage, type StoredLinkSlotOverride } from "../src/storage"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import { decorateOperationScopedMethodForTesting } from "../src/storage/operation-scope"
import { queueTestActionRun } from "../src/testing"
import {
  atomic,
  createMaterializerFixture,
  replacement,
  sourceEntry,
  sourceEntryAt,
  sourceEntryWithParent,
} from "./materializer-fixture"

const ref = (primaryId: string) => ({ objectTypeId: "Device", primaryId })

describe("ontology materializer edits", () => {
  test("derives durable provenance and event actor from the bound principal scope", async () => {
    const storage = new InMemoryStorage()
    await storage.auth.users.create({
      projectId: "project",
      id: "user-1",
      email: "user-1@example.com",
    })
    const scope = createTestingScope({
      projectId: "project",
      executionId: "principal-execution",
      requestId: "principal-request",
      correlationId: "principal-correlation",
      context: {
        principal: { type: "user", id: "user-1" },
        groupIds: [],
        roleIds: [],
        grants: emptyGrantIndex(),
      },
    })
    const { materializer } = createMaterializerFixture({ storage, scope })

    const result = await materializer.edits.commit(
      atomic("principal-write", [
        {
          id: "create",
          kind: "object.create",
          ref: ref("principal-object"),
          properties: { name: "Principal object" },
        },
      ])
    )
    await expect(
      storage.executions.getById({ projectId: "project", id: scope.execution.id })
    ).resolves.toMatchObject({
      requestedBy: { type: "user", id: "user-1" },
      authorizationRef: { type: "principal", principal: { type: "user", id: "user-1" } },
    })
    await expect(
      storage.ontology.commits.getById({ projectId: "project", id: result.commitId })
    ).resolves.toMatchObject({
      executionId: "principal-execution",
      actor: { type: "user", id: "user-1" },
    })
    const [event] = await storage.ontology.outbox.claim({
      projectId: "project",
      now: "2027-01-01T00:00:00.000Z",
      limit: 10,
      leaseId: "principal-events",
      leaseExpiresAt: "2027-01-01T01:00:00.000Z",
    })
    expect(event.envelope).toMatchObject({
      correlationId: "principal-correlation",
      actor: { type: "user", id: "user-1" },
    })
  })

  test("rejects replaying one request id from a different execution", async () => {
    const storage = new InMemoryStorage()
    const materializerFor = (executionId: string) =>
      createMaterializerFixture({
        storage,
        scope: createTestingScope({
          projectId: "project",
          executionId,
          requestId: "shared-request",
          correlationId: `correlation:${executionId}`,
        }),
      }).materializer

    await materializerFor("execution-1").edits.commit(atomic("shared-request", []))
    await expect(
      materializerFor("execution-2").edits.commit(atomic("shared-request", []))
    ).rejects.toThrow("belongs to execution 'execution-1', not 'execution-2'")
  })

  test("rejects an Action commit before mutation when strict run capabilities are absent", async () => {
    class StorageWithoutActionFence extends InMemoryStorage {
      private readonly missingActionRuns: Storage["actionRuns"] = undefined

      constructor() {
        super()
        Object.defineProperty(this, "actionRuns", { value: this.missingActionRuns })
      }

      override transaction<T>(run: (tx: Storage) => Promise<T> | T): Promise<T> {
        return super.transaction((tx) => run({ ...tx, actionRuns: this.missingActionRuns }))
      }
    }
    const storage = new StorageWithoutActionFence()
    const { materializer } = createMaterializerFixture({ storage })

    await expect(
      materializer.edits.commit({
        mode: "atomic",
        source: { kind: "action", actionId: "approve", runId: "run-1" },
        operations: [],
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
    ).rejects.toThrow("Action run capabilities required")
  })

  test("rejects invalid Action runs before ontology reads, staging, or mutation", async () => {
    const scenarios = [
      { kind: "absent", storedActionId: null, start: false, error: "not found" },
      {
        kind: "wrong-action",
        storedActionId: "other",
        start: true,
        error: "does not authorize",
      },
      { kind: "not-running", storedActionId: "approve", start: false, error: "status 'queued'" },
    ] as const

    for (const scenario of scenarios) {
      const storage = new InMemoryStorage()
      const runId = `run-${scenario.kind}`
      if (scenario.storedActionId) {
        await queueTestActionRun(storage, {
          id: runId,
          projectId: "project",
          actionId: scenario.storedActionId,
          subject: { kind: "none" },
          params: {},
          idempotencyKey: `action:${runId}`,
        })
        if (scenario.start) await storage.actionRuns.start({ id: runId, projectId: "project" })
      }
      const { materializer } = createMaterializerFixture({ storage })
      const adapter = getInMemoryOntologyStorageTestingAdapter(storage.ontology)
      const before = adapter.snapshot()
      const ontologyActivity: string[] = []
      adapter.setTestHooks({
        beforeRead(boundary) {
          ontologyActivity.push(`read:${boundary}`)
        },
        beforeWrite(boundary, ordinal) {
          ontologyActivity.push(`write:${boundary}:${ordinal}`)
        },
        observeWork(records) {
          ontologyActivity.push(`stage:${records.length}`)
        },
      })

      await expect(
        materializer.edits.commit({
          mode: "atomic",
          source: { kind: "action", actionId: "approve", runId },
          operations: [
            {
              id: "create",
              kind: "object.create",
              ref: ref(`preflight-${scenario.kind}`),
              properties: { name: "must-not-exist" },
            },
          ],
          expectedObjects: [],
          expectedLinks: [],
          expectedLinkScopes: [],
        })
      ).rejects.toThrow(scenario.error)

      expect(ontologyActivity).toEqual([])
      expect(adapter.snapshot()).toEqual(before)
      adapter.setTestHooks({})
      expect(
        await storage.objects.getByPrimaryId({
          projectId: "project",
          objectTypeId: "Device",
          primaryId: `preflight-${scenario.kind}`,
        })
      ).toBeNull()
    }
  })

  test("materializes a valid running Action without duplicating its ontology commit", async () => {
    const storage = new InMemoryStorage()
    await queueTestActionRun(storage, {
      id: "run-valid",
      projectId: "project",
      actionId: "approve",
      subject: { kind: "none" },
      params: {},
      idempotencyKey: "action:run-valid",
    })
    await storage.actionRuns.start({ id: "run-valid", projectId: "project" })
    const { materializer } = createMaterializerFixture({ storage })

    const result = await materializer.edits.commit({
      mode: "atomic",
      source: { kind: "action", actionId: "approve", runId: "run-valid" },
      operations: [
        {
          id: "create",
          kind: "object.create",
          ref: ref("action-created"),
          properties: { name: "created" },
        },
      ],
      expectedObjects: [],
      expectedLinks: [],
      expectedLinkScopes: [],
    })

    expect(result.created).toBe(true)
    expect(
      await storage.actionRuns.getById({ projectId: "project", id: "run-valid" })
    ).not.toHaveProperty("commitId")
    await expect(
      storage.ontology.commits.list({
        projectId: "project",
        run: { kind: "action", id: "run-valid" },
      })
    ).resolves.toMatchObject({
      commits: [{ id: result.commitId, origin: { kind: "action", runId: "run-valid" } }],
      total: 1,
      hasMore: false,
    })
  })

  test("replays an exact Action commit after the run becomes terminal", async () => {
    const storage = new InMemoryStorage()
    await queueTestActionRun(storage, {
      id: "run-replay",
      projectId: "project",
      actionId: "approve",
      subject: { kind: "none" },
      params: {},
      idempotencyKey: "action:run-replay",
    })
    await storage.actionRuns.start({ id: "run-replay", projectId: "project" })
    const { materializer } = createMaterializerFixture({ storage })
    const input = {
      mode: "atomic" as const,
      source: { kind: "action" as const, actionId: "approve", runId: "run-replay" },
      operations: [
        {
          id: "create",
          kind: "object.create" as const,
          ref: ref("action-replayed"),
          properties: { name: "created" },
        },
      ],
      expectedObjects: [],
      expectedLinks: [],
      expectedLinkScopes: [],
    }

    const first = await materializer.edits.commit(input)
    await storage.actionRuns.finish({
      projectId: "project",
      id: "run-replay",
      status: "succeeded",
    })

    await expect(materializer.edits.commit(input)).resolves.toMatchObject({
      commitId: first.commitId,
      created: false,
    })
    await expect(
      materializer.edits.commit({
        ...input,
        operations: [{ id: "different", kind: "object.delete", ref: ref("action-replayed") }],
      })
    ).rejects.toMatchObject({ kind: "idempotency" })
  })

  test("rechecks the Action run inside the transaction before ontology work", async () => {
    const storage = new InMemoryStorage()
    await queueTestActionRun(storage, {
      id: "run-recheck",
      projectId: "project",
      actionId: "approve",
      subject: { kind: "none" },
      params: {},
      idempotencyKey: "action:run-recheck",
    })
    await storage.actionRuns.start({ id: "run-recheck", projectId: "project" })
    let locks = 0
    decorateOperationScopedMethodForTesting(
      storage.actionRuns,
      "lockForMaterialization",
      () => async () => {
        locks += 1
        throw new Error("injected transactional Action lock failure")
      }
    )
    const { materializer } = createMaterializerFixture({ storage })
    const adapter = getInMemoryOntologyStorageTestingAdapter(storage.ontology)
    const before = adapter.snapshot()
    const ontologyActivity: string[] = []
    adapter.setTestHooks({
      beforeRead(boundary) {
        ontologyActivity.push(`read:${boundary}`)
      },
      beforeWrite(boundary, ordinal) {
        ontologyActivity.push(`write:${boundary}:${ordinal}`)
      },
      observeWork(records) {
        ontologyActivity.push(`stage:${records.length}`)
      },
    })

    await expect(
      materializer.edits.commit({
        mode: "atomic",
        source: { kind: "action", actionId: "approve", runId: "run-recheck" },
        operations: [
          {
            id: "create",
            kind: "object.create",
            ref: ref("transaction-recheck"),
            properties: { name: "must-not-exist" },
          },
        ],
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
    ).rejects.toThrow("injected transactional Action lock failure")

    expect(locks).toBe(1)
    expect(ontologyActivity).toEqual([])
    expect(adapter.snapshot()).toEqual(before)
  })

  test("skips incident hubs for presence-preserving patches and pages them for deletion", async () => {
    const { materializer, storage } = createMaterializerFixture({
      dependencies: {
        batching: { sourceStageRows: 20, statePageRows: 2, planChunkRows: 7 },
      },
    })
    const values = [sourceEntry("hub", "hub")]
    for (let index = 0; index < 150; index += 1) {
      values.push(sourceEntryWithParent(`leaf-${index}`, `leaf-${index}`, "hub"))
    }
    await materializer.projections.replace(replacement("hub-v1", "2026-01-01T00:00:00Z", values))

    const patchBuffers: string[] = []
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      observeBuffer(boundary) {
        patchBuffers.push(boundary)
      },
    })
    await materializer.edits.commit(
      atomic("hub-patch", [
        {
          id: "patch",
          kind: "object.patch",
          ref: ref("hub"),
          set: { name: "patched" },
          unset: [],
          reset: [],
        },
      ])
    )
    expect(patchBuffers).not.toContain("state.incident-link.page")

    let maxIncidentPage = 0
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      observeBuffer(boundary, rows) {
        if (boundary === "state.incident-link.page")
          maxIncidentPage = Math.max(maxIncidentPage, rows)
      },
    })
    const deleted = await materializer.edits.commit(
      atomic("hub-delete", [{ id: "delete", kind: "object.delete", ref: ref("hub") }])
    )
    expect(deleted.changes.links).toHaveLength(150)
    expect(maxIncidentPage).toBeLessThanOrEqual(2)
  })

  test("does not retain unchanged dormant incident authority for a large hub", async () => {
    const { materializer, storage } = createMaterializerFixture({
      dependencies: { batching: { statePageRows: 7, planChunkRows: 31 } },
    })
    const leafCount = 500
    await materializer.edits.commit(
      atomic("dormant-hub-objects", [
        {
          id: "hub",
          kind: "object.create",
          ref: ref("hub"),
          properties: { name: "hub" },
        },
        ...Array.from({ length: leafCount }, (_, index) => ({
          id: `leaf-${index}`,
          kind: "object.create" as const,
          ref: ref(`leaf-${index}`),
          properties: { name: `leaf-${index}` },
        })),
      ])
    )
    await materializer.edits.commit(
      atomic(
        "dormant-hub-links",
        Array.from({ length: leafCount }, (_, index) => ({
          id: `link-${index}`,
          kind: "link.upsert" as const,
          ref: {
            source: ref(`leaf-${index}`),
            linkId: "parent",
            target: ref("hub"),
          },
        }))
      )
    )
    await materializer.edits.commit(
      atomic(
        "dormant-hub-withdraw",
        Array.from({ length: leafCount }, (_, index) => ({
          id: `delete-${index}`,
          kind: "object.delete" as const,
          ref: ref(`leaf-${index}`),
        }))
      )
    )

    let maxRetainedIncidentLinks = 0
    const observed = createMaterializerFixture({
      storage,
      dependencies: {
        batching: { statePageRows: 7, planChunkRows: 31 },
        observeCoreBuffer(boundary, rows) {
          if (boundary === "edits.incident-links") {
            maxRetainedIncidentLinks = Math.max(maxRetainedIncidentLinks, rows)
          }
        },
      },
    }).materializer
    const deleted = await observed.edits.commit(
      atomic("dormant-hub-delete", [{ id: "delete", kind: "object.delete", ref: ref("hub") }])
    )
    expect(deleted.changes.links).toEqual([])
    expect(maxRetainedIncidentLinks).toBe(0)
  })

  test("pages a large cardinality-many hub without materializing nested scopes", async () => {
    const { materializer, storage } = createMaterializerFixture({
      dependencies: { batching: { statePageRows: 11, planChunkRows: 47 } },
    })
    await materializer.projections.replace(
      replacement("scope-control", "2026-01-01T00:00:00Z", [
        sourceEntryWithParent("scope-one", "scope one", "scope-two"),
        sourceEntry("scope-two", "scope two"),
      ])
    )
    const linkCount = 2_000
    await materializer.edits.commit(
      atomic("many-hub-objects", [
        {
          id: "hub",
          kind: "object.create",
          ref: ref("many-hub"),
          properties: { name: "many hub" },
        },
        ...Array.from({ length: linkCount }, (_, index) => ({
          id: `target-${index}`,
          kind: "object.create" as const,
          ref: ref(`many-target-${index}`),
          properties: { name: `target ${index}` },
        })),
      ])
    )
    await materializer.edits.commit(
      atomic(
        "many-hub-links",
        Array.from({ length: linkCount }, (_, index) => ({
          id: `link-${index}`,
          kind: "link.upsert" as const,
          ref: {
            source: ref("many-hub"),
            linkId: "peers",
            target: ref(`many-target-${index}`),
          },
        }))
      )
    )
    let maxIncidentPage = 0
    let maxScopePage = 0
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      observeBuffer(boundary, rows) {
        if (boundary === "state.incident-link.page") {
          maxIncidentPage = Math.max(maxIncidentPage, rows)
        }
        if (boundary === "state.link-scope.page") maxScopePage = Math.max(maxScopePage, rows)
      },
    })
    const controlRef = {
      source: ref("scope-one"),
      linkId: "parent",
      target: ref("scope-two"),
    }
    await materializer.edits.commit(
      atomic("scope-control-delete", [{ id: "delete", kind: "link.delete", ref: controlRef }])
    )
    await materializer.edits.commit(
      atomic("scope-control-reset", [{ id: "reset", kind: "link.reset", ref: controlRef }])
    )
    const deleted = await materializer.edits.commit(
      atomic("many-hub-delete", [{ id: "delete", kind: "object.delete", ref: ref("many-hub") }])
    )
    expect(deleted.changes.links).toHaveLength(linkCount)
    expect(maxIncidentPage).toBeLessThanOrEqual(11)
    expect(maxScopePage).toBeLessThanOrEqual(1)
  })

  test("persists same-value authority without an effective write and reset reveals source", async () => {
    const { materializer, storage } = createMaterializerFixture()
    await materializer.projections.replace(
      replacement("v1", "2026-01-01T00:00:00Z", [sourceEntry("one", "source")])
    )

    const same = await materializer.edits.commit(
      atomic("same-value", [
        { id: "upsert", kind: "object.upsert", ref: ref("one"), properties: { name: "source" } },
      ])
    )
    expect(same.outcomes).toEqual([
      expect.objectContaining({ id: "upsert", ok: true, authority: "changed" }),
    ])
    expect(same.changes.objects).toEqual([])
    expect(same.eventCount).toBe(0)

    const repeated = await materializer.edits.commit(
      atomic("same-value-again", [
        { id: "upsert", kind: "object.upsert", ref: ref("one"), properties: { name: "source" } },
      ])
    )
    expect(repeated.outcomes[0]).toEqual(expect.objectContaining({ authority: "unchanged" }))

    const changed = await materializer.edits.commit(
      atomic("change", [
        {
          id: "patch",
          kind: "object.patch",
          ref: ref("one"),
          set: { name: "edited" },
          unset: [],
          reset: [],
        },
      ])
    )
    expect(changed.changes.objects[0].kind).toBe("updated")

    await materializer.edits.commit(
      atomic("reset", [
        {
          id: "reset",
          kind: "object.patch",
          ref: ref("one"),
          set: {},
          unset: [],
          reset: ["name"],
        },
      ])
    )
    expect(
      (
        await storage.objects.getByPrimaryId({
          projectId: "project",
          objectTypeId: "Device",
          primaryId: "one",
        })
      )?.properties.name
    ).toBe("source")
  })

  test("resolves most-recent source and edit candidates independently per property", async () => {
    let now = new Date("2026-01-01T10:00:00.000Z")
    const { materializer, storage } = createMaterializerFixture({
      conflictResolution: "mostRecent",
      dependencies: { clock: () => now },
    })
    const object = async () =>
      storage.objects.getByPrimaryId({
        projectId: "project",
        objectTypeId: "Device",
        primaryId: "one",
      })

    await materializer.projections.replace(
      replacement("recent-v1", "2026-01-01T00:00:00Z", [
        sourceEntryAt("one", "A", "2026-01-01T10:00:00Z", "source-note-1"),
      ])
    )

    now = new Date("2026-01-01T11:00:00.000Z")
    const nameEdit = await materializer.edits.commit(
      atomic("recent-edit-name", [
        {
          id: "name",
          kind: "object.patch",
          ref: ref("one"),
          set: { name: "B" },
          unset: [],
          reset: [],
        },
      ])
    )
    const nameEditOutcome = nameEdit.outcomes[0]
    expect(nameEditOutcome?.ok).toBe(true)
    if (!nameEditOutcome?.ok) throw new Error("Expected the name edit to succeed.")
    expect(nameEditOutcome.object).not.toHaveProperty("propertyConflicts")

    await materializer.projections.replace(
      replacement("recent-v2", "2026-01-02T00:00:00Z", [
        sourceEntryAt("one", "source-still-old", "2026-01-01T10:00:00Z", "source-note-2"),
      ])
    )
    expect((await object())?.properties).toMatchObject({ name: "B", note: "source-note-2" })

    now = new Date("2026-01-01T13:00:00.000Z")
    await materializer.edits.commit(
      atomic("recent-edit-note", [
        {
          id: "note",
          kind: "object.patch",
          ref: ref("one"),
          set: { note: "local-note" },
          unset: [],
          reset: [],
        },
      ])
    )
    const [storedOverride] = [
      ...getInMemoryOntologyStorageTestingAdapter(storage.ontology)
        .snapshot()
        .objectOverrides.values(),
    ]
    expect(storedOverride?.editedAt).toEqual({
      name: "2026-01-01T11:00:00.000Z",
      note: "2026-01-01T13:00:00.000Z",
    })

    await materializer.projections.replace(
      replacement("recent-v3", "2026-01-03T00:00:00Z", [
        sourceEntryAt("one", "C", "2026-01-01T12:00:00Z", "source-note-3"),
      ])
    )
    expect((await object())?.properties).toMatchObject({ name: "C", note: "local-note" })

    const tied = await materializer.projections.replace(
      replacement("recent-v4", "2026-01-04T00:00:00Z", [
        sourceEntryAt("one", "D", "2026-01-01T13:00:00Z", "source-note-4"),
      ])
    )
    expect((await object())?.properties).toMatchObject({ name: "D", note: "source-note-4" })
    expect(tied.counts.objectsUpdated).toBe(1)

    await materializer.projections.replace(
      replacement("recent-v5", "2026-01-05T00:00:00Z", [
        sourceEntryAt("one", "E", "2026-01-01T14:00:00Z"),
      ])
    )
    const withoutSourceNote = await object()
    expect(withoutSourceNote?.properties.name).toBe("E")
    expect(withoutSourceNote?.properties).not.toHaveProperty("note")

    const activeSource = [
      ...getInMemoryOntologyStorageTestingAdapter(storage.ontology)
        .snapshot()
        .sourceMaterializations.values(),
    ].find((source) => source.status === "active")
    const activeObjectAssertion = [...(activeSource?.rowsByEntity.values() ?? [])].find(
      (row) => row.assertion.kind === "object"
    )?.assertion
    expect(activeObjectAssertion).toEqual({
      kind: "object",
      ref: ref("one"),
      properties: { name: "E" },
      sourceUpdatedAt: "2026-01-01T14:00:00.000Z",
      absentSourcePropertyIds: ["note"],
    })
  })

  test("preserves a dormant edit timestamp when deleting an absent object", async () => {
    let now = new Date("2026-01-01T10:00:00.000Z")
    const { materializer, storage } = createMaterializerFixture({
      conflictResolution: "mostRecent",
      dependencies: { clock: () => now },
    })

    await materializer.projections.replace(
      replacement("dormant-time-v1", "2026-01-01T00:00:00Z", [
        sourceEntryAt("one", "source", "2026-01-01T10:00:00Z"),
      ])
    )
    now = new Date("2026-01-01T11:00:00.000Z")
    await materializer.edits.commit(
      atomic("dormant-time-edit", [
        {
          id: "name",
          kind: "object.patch",
          ref: ref("one"),
          set: { name: "edited" },
          unset: [],
          reset: [],
        },
      ])
    )
    await materializer.projections.replace(
      replacement("dormant-time-v2", "2026-01-02T00:00:00Z", [])
    )

    now = new Date("2026-01-01T20:00:00.000Z")
    await materializer.edits.commit(
      atomic("dormant-time-delete", [{ id: "delete", kind: "object.delete", ref: ref("one") }])
    )

    const [storedOverride] = [
      ...getInMemoryOntologyStorageTestingAdapter(storage.ontology)
        .snapshot()
        .objectOverrides.values(),
    ]
    expect(storedOverride?.editedAt).toEqual({ name: "2026-01-01T11:00:00.000Z" })

    await materializer.projections.replace(
      replacement("dormant-time-v3", "2026-01-03T00:00:00Z", [
        sourceEntryAt("one", "newer source", "2026-01-01T12:00:00Z"),
      ])
    )
    await expect(
      storage.objects.getByPrimaryId({
        projectId: "project",
        objectTypeId: "Device",
        primaryId: "one",
      })
    ).resolves.toMatchObject({ properties: { name: "newer source" } })
  })

  test("supports create-to-patch, tombstone, dormant patch, and restore semantics", async () => {
    const { materializer, storage } = createMaterializerFixture()
    await materializer.edits.commit(
      atomic("create", [
        {
          id: "create",
          kind: "object.create",
          ref: ref("one"),
          properties: { name: "independent" },
        },
      ])
    )
    await materializer.projections.replace(
      replacement("v1", "2026-01-01T00:00:00Z", [sourceEntry("one", "source")])
    )
    expect(
      (
        await storage.objects.getByPrimaryId({
          projectId: "project",
          objectTypeId: "Device",
          primaryId: "one",
        })
      )?.properties.name
    ).toBe("independent")

    await materializer.edits.commit(
      atomic("transition", [
        { id: "reset", kind: "object.patch", ref: ref("one"), set: {}, unset: [], reset: ["name"] },
      ])
    )
    expect(
      (
        await storage.objects.getByPrimaryId({
          projectId: "project",
          objectTypeId: "Device",
          primaryId: "one",
        })
      )?.properties.name
    ).toBe("source")

    await materializer.edits.commit(
      atomic("patch", [
        {
          id: "patch",
          kind: "object.patch",
          ref: ref("one"),
          set: { name: "durable" },
          unset: [],
          reset: [],
        },
      ])
    )
    await materializer.projections.replace(replacement("v2", "2026-01-02T00:00:00Z", []))
    expect(
      await storage.objects.getByPrimaryId({
        projectId: "project",
        objectTypeId: "Device",
        primaryId: "one",
      })
    ).toBeNull()

    await materializer.edits.commit(
      atomic("dormant-edit", [
        {
          id: "patch",
          kind: "object.patch",
          ref: ref("one"),
          set: { name: "while absent" },
          unset: [],
          reset: [],
        },
      ])
    )
    await materializer.projections.replace(
      replacement("v3", "2026-01-03T00:00:00Z", [sourceEntry("one", "returned")])
    )
    expect(
      (
        await storage.objects.getByPrimaryId({
          projectId: "project",
          objectTypeId: "Device",
          primaryId: "one",
        })
      )?.properties.name
    ).toBe("while absent")

    await materializer.edits.commit(
      atomic("delete", [{ id: "delete", kind: "object.delete", ref: ref("one") }])
    )
    expect(
      await storage.objects.getByPrimaryId({
        projectId: "project",
        objectTypeId: "Device",
        primaryId: "one",
      })
    ).toBeNull()
    await materializer.edits.commit(
      atomic("restore", [{ id: "restore", kind: "object.restore", ref: ref("one") }])
    )
    expect(
      (
        await storage.objects.getByPrimaryId({
          projectId: "project",
          objectTypeId: "Device",
          primaryId: "one",
        })
      )?.properties.name
    ).toBe("returned")
  })

  test("promotes a dormant patch to an independent upsert create while preserving unset", async () => {
    const { materializer, storage } = createMaterializerFixture()
    await materializer.projections.replace(
      replacement("dormant-upsert-v1", "2026-01-01T00:00:00Z", [
        sourceEntry("one", "source", "remove-me"),
      ])
    )
    await materializer.edits.commit(
      atomic("dormant-upsert-patch", [
        {
          id: "patch",
          kind: "object.patch",
          ref: ref("one"),
          set: {},
          unset: ["note"],
          reset: [],
        },
      ])
    )
    await materializer.projections.replace(
      replacement("dormant-upsert-v2", "2026-01-02T00:00:00Z", [])
    )
    const result = await materializer.edits.commit(
      atomic("dormant-upsert", [
        {
          id: "upsert",
          kind: "object.upsert",
          ref: ref("one"),
          properties: { name: "independent" },
        },
      ])
    )
    expect(result.outcomes[0]).toEqual(
      expect.objectContaining({ id: "upsert", ok: true, authority: "changed" })
    )
    expect(
      (
        await storage.objects.getByPrimaryId({
          projectId: "project",
          objectTypeId: "Device",
          primaryId: "one",
        })
      )?.properties
    ).toEqual({ id: "one", name: "independent" })
  })

  test("continues after unknown delete, restore, and reset references", async () => {
    const { materializer } = createMaterializerFixture()
    const result = await materializer.edits.commit({
      mode: "continue",
      source: { kind: "runtime", requestId: "continue-invalid-refs" },
      operations: [
        {
          id: "unknown-delete",
          kind: "object.delete",
          ref: { objectTypeId: "Missing", primaryId: "one" },
        },
        {
          id: "unknown-restore",
          kind: "object.restore",
          ref: { objectTypeId: "Missing", primaryId: "one" },
        },
        {
          id: "unknown-link",
          kind: "link.reset",
          ref: {
            source: ref("one"),
            linkId: "missing",
            target: ref("two"),
          },
        },
        {
          id: "invalid-target",
          kind: "link.delete",
          ref: {
            source: ref("one"),
            linkId: "parent",
            target: { objectTypeId: "Missing", primaryId: "two" },
          },
        },
        {
          id: "valid",
          kind: "object.create",
          ref: ref("valid"),
          properties: { name: "valid" },
        },
      ],
    })
    expect(result.outcomes.slice(0, 4)).toEqual(
      Array.from({ length: 4 }, () =>
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: "validation" }),
        })
      )
    )
    expect(result.outcomes[4]).toEqual(expect.objectContaining({ id: "valid", ok: true }))
  })

  test("orders continue operations, isolates semantic errors, enforces cardinality, and withdraws incident links", async () => {
    const { materializer, storage } = createMaterializerFixture()
    const result = await materializer.edits.commit({
      mode: "continue",
      source: { kind: "runtime", requestId: "batch" },
      operations: [
        { id: "one", kind: "object.create", ref: ref("one"), properties: { name: "one" } },
        { id: "bad", kind: "object.create", ref: ref("bad"), properties: {} },
        { id: "two", kind: "object.create", ref: ref("two"), properties: { name: "two" } },
        { id: "three", kind: "object.create", ref: ref("three"), properties: { name: "three" } },
        {
          id: "first-link",
          kind: "link.upsert",
          ref: { source: ref("one"), linkId: "parent", target: ref("two") },
        },
        {
          id: "cardinality",
          kind: "link.upsert",
          ref: { source: ref("one"), linkId: "parent", target: ref("three") },
        },
      ],
    })
    expect(result.outcomes.map((outcome) => outcome.ok)).toEqual([
      true,
      false,
      true,
      true,
      true,
      false,
    ])
    expect(
      await storage.objects.getByPrimaryId({
        projectId: "project",
        objectTypeId: "Device",
        primaryId: "bad",
      })
    ).toBeNull()
    expect(
      await storage.objects.listLinks({
        projectId: "project",
        objectTypeId: "Device",
        objectId: "one",
      })
    ).toHaveLength(1)

    const deleted = await materializer.edits.commit(
      atomic("delete-target", [{ id: "delete", kind: "object.delete", ref: ref("two") }])
    )
    expect(deleted.changes.links.map((change) => change.kind)).toEqual(["deleted"])
    expect(
      await storage.objects.listLinks({
        projectId: "project",
        objectTypeId: "Device",
        objectId: "one",
      })
    ).toEqual([])
  })

  test("rolls back every operation in a failed continue-mode group", async () => {
    const { materializer, storage } = createMaterializerFixture()
    await materializer.edits.commit(
      atomic("seed-group-rollback", [
        { id: "one", kind: "object.create", ref: ref("one"), properties: { name: "one" } },
        { id: "two", kind: "object.create", ref: ref("two"), properties: { name: "two" } },
        {
          id: "link",
          kind: "link.upsert",
          ref: { source: ref("one"), linkId: "parent", target: ref("two") },
        },
      ])
    )

    const result = await materializer.edits.commit({
      mode: "continue",
      source: { kind: "runtime", requestId: "group-rollback" },
      operations: [
        {
          id: "delete-link",
          kind: "link.delete",
          ref: { source: ref("one"), linkId: "parent", target: ref("two") },
        },
        { id: "invalid-object", kind: "object.create", ref: ref("invalid"), properties: {} },
      ],
      operationGroups: [["delete-link", "invalid-object"]],
    })

    expect(result.outcomes).toEqual([
      expect.objectContaining({ id: "delete-link", ok: false }),
      expect.objectContaining({ id: "invalid-object", ok: false }),
    ])
    expect(
      await storage.objects.listLinks({
        projectId: "project",
        objectTypeId: "Device",
        objectId: "one",
        linkId: "parent",
      })
    ).toHaveLength(1)
  })

  test("checks expected object revisions and divergent idempotency", async () => {
    const { materializer } = createMaterializerFixture()
    await materializer.edits.commit(
      atomic("create", [
        { id: "create", kind: "object.create", ref: ref("one"), properties: { name: "one" } },
      ])
    )
    await expect(
      materializer.edits.commit({
        mode: "atomic",
        source: { kind: "runtime", requestId: "stale" },
        operations: [],
        expectedObjects: [{ ref: ref("one"), exists: false }],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
    ).rejects.toBeInstanceOf(MaterializationConflictError)

    const first = await materializer.edits.commit(atomic("replay", []))
    const replay = await materializer.edits.commit(atomic("replay", []))
    expect(first.created).toBe(true)
    expect(replay.created).toBe(false)
    await expect(
      materializer.edits.commit(
        atomic("replay", [{ id: "different", kind: "object.delete", ref: ref("one") }])
      )
    ).rejects.toMatchObject({ kind: "idempotency" })
  })

  test("continue mode rethrows provider failures and rolls back prior successes", async () => {
    const { materializer, storage } = createMaterializerFixture()
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      beforeWrite() {
        throw new Error("injected provider write failure")
      },
    })

    await expect(
      materializer.edits.commit({
        mode: "continue",
        source: { kind: "runtime", requestId: "provider-failure" },
        operations: [
          { id: "first", kind: "object.create", ref: ref("first"), properties: { name: "one" } },
          { id: "second", kind: "object.create", ref: ref("second"), properties: { name: "two" } },
        ],
      })
    ).rejects.toThrow("injected provider write failure")
    expect(
      await storage.objects.getByPrimaryId({
        projectId: "project",
        objectTypeId: "Device",
        primaryId: "first",
      })
    ).toBeNull()
  })

  test("bounds staged work by UTF-8 bytes with oversize single records", async () => {
    let maxWorkStage = 0
    const { materializer, storage } = createMaterializerFixture({
      dependencies: { batching: { planChunkRows: 100, planChunkBytes: 1 } },
    })
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      observeBuffer(boundary, rows) {
        if (boundary === "work.stage") maxWorkStage = Math.max(maxWorkStage, rows)
      },
    })
    await materializer.edits.commit(
      atomic("unicode-work-bytes", [
        {
          id: "unicode",
          kind: "object.create",
          ref: ref("😀"),
          properties: { name: "😀😀😀" },
        },
      ])
    )
    expect(maxWorkStage).toBe(1)
  })

  test("validates patch unset and reset property ids", async () => {
    const { materializer } = createMaterializerFixture()
    await materializer.edits.commit(
      atomic("patch-property-create", [
        { id: "create", kind: "object.create", ref: ref("one"), properties: { name: "one" } },
      ])
    )
    for (const [propertyId, message] of [
      ["unknown", "unknown property"],
      ["id", "primary property"],
      ["temperature", "telemetry property"],
    ] as const) {
      await expect(
        materializer.edits.commit(
          atomic(`patch-unset-${propertyId}`, [
            {
              id: "patch",
              kind: "object.patch",
              ref: ref("one"),
              set: {},
              unset: [propertyId],
              reset: [],
            },
          ])
        )
      ).rejects.toThrow(message)
      await expect(
        materializer.edits.commit(
          atomic(`patch-reset-${propertyId}`, [
            {
              id: "patch",
              kind: "object.patch",
              ref: ref("one"),
              set: {},
              unset: [],
              reset: [propertyId],
            },
          ])
        )
      ).rejects.toThrow(message)
    }
  })

  test("captures ordered step-local object outcomes while retaining one net change", async () => {
    const { materializer } = createMaterializerFixture()
    const result = await materializer.edits.commit(
      atomic("step-outcomes", [
        { id: "create", kind: "object.create", ref: ref("one"), properties: { name: "first" } },
        {
          id: "patch",
          kind: "object.patch",
          ref: ref("one"),
          set: { name: "second" },
          unset: [],
          reset: [],
        },
        { id: "delete", kind: "object.delete", ref: ref("one") },
        { id: "upsert", kind: "object.upsert", ref: ref("one"), properties: { name: "third" } },
      ])
    )

    expect(result.outcomes.map((outcome) => outcome.ok && outcome.object?.properties.name)).toEqual(
      ["first", "second", undefined, "third"]
    )
    expect(result.changes.objects).toHaveLength(1)
    expect(result.changes.objects[0]).toMatchObject({
      kind: "created",
      after: { properties: { name: "third" } },
    })
  })

  test("rejects a migrated cardinality-one slot conflict before applying edits", async () => {
    // To prove this guard, make usableLinkSlotOverride accept legacy-conflict; this test must fail.
    const { materializer, storage } = createMaterializerFixture()
    await materializer.projections.replace(
      replacement("legacy-conflict-v1", "2026-01-01T00:00:00Z", [
        sourceEntryWithParent("one", "one", "two"),
        sourceEntry("two", "two"),
      ])
    )
    const conflict = {
      ref: { source: ref("one"), linkId: "parent" },
      value: { kind: "legacy-conflict" },
      lastCommitId: "legacy-conflict-commit",
      updatedAt: "2026-01-02T00:00:00.000Z",
    } satisfies StoredLinkSlotOverride
    const matchesScope = (source: { objectTypeId: string; primaryId: string }, linkId: string) =>
      source.objectTypeId === "Device" && source.primaryId === "one" && linkId === "parent"
    const restoreStreamState = decorateOperationScopedMethodForTesting(
      storage.ontology.materializations,
      "streamState",
      (streamState) =>
        async function* (input) {
          for await (const page of streamState(input)) {
            yield {
              ...page,
              links: page.links.map((link) =>
                matchesScope(link.ref.source, link.ref.linkId)
                  ? { ...link, slotOverride: conflict }
                  : link
              ),
              linkScopes: page.linkScopes.map((scope) =>
                matchesScope(scope.source, scope.linkId) ? { ...scope, override: conflict } : scope
              ),
            }
          }
        }
    )

    try {
      await expect(
        materializer.edits.commit(
          atomic("legacy-conflict-edit", [
            {
              id: "reset",
              kind: "link.reset",
              ref: { source: ref("one"), linkId: "parent", target: ref("two") },
            },
          ])
        )
      ).rejects.toThrow("could not be migrated automatically")
    } finally {
      restoreStreamState()
    }

    expect(
      (
        await storage.objects.listLinks({
          projectId: "project",
          objectTypeId: "Device",
          objectId: "one",
          linkId: "parent",
        })
      ).map((link) => link.targetId)
    ).toEqual(["two"])
  })

  test("restore keeps a cardinality-one scope override authoritative over dormant source", async () => {
    for (const statePageRows of [1, 1_000]) {
      const { materializer, storage } = createMaterializerFixture({
        dependencies: { batching: { statePageRows } },
      })
      await materializer.projections.replace(
        replacement("restore-v1", "2026-01-01T00:00:00Z", [
          {
            ...sourceEntry("source", "source"),
            assertions: [
              ...sourceEntry("source", "source").assertions,
              {
                kind: "link",
                ref: { source: ref("source"), linkId: "parent", target: ref("dormant") },
              },
            ],
          },
          sourceEntry("dormant", "dormant"),
          sourceEntry("live", "live"),
        ])
      )
      await materializer.edits.commit(
        atomic("hide-target", [{ id: "delete", kind: "object.delete", ref: ref("dormant") }])
      )
      await materializer.edits.commit(
        atomic("live-link", [
          {
            id: "link",
            kind: "link.upsert",
            ref: { source: ref("source"), linkId: "parent", target: ref("live") },
          },
        ])
      )

      await materializer.edits.commit(
        atomic("restore-target", [{ id: "restore", kind: "object.restore", ref: ref("dormant") }])
      )
      expect(
        await storage.objects.getByPrimaryId({
          projectId: "project",
          objectTypeId: "Device",
          primaryId: "dormant",
        })
      ).not.toBeNull()
      expect(
        (
          await storage.objects.listLinks({
            projectId: "project",
            objectTypeId: "Device",
            objectId: "source",
          })
        ).map((link) => link.targetId)
      ).toEqual(["live"])
    }
  })

  test("preloads edit state with a constant number of reads across batch boundaries", async () => {
    for (const operationCount of [1, 1_000, 1_001]) {
      const { materializer, storage } = createMaterializerFixture()
      await materializer.projections.replace(
        replacement(`edit-read-scale-source-${operationCount}`, "2026-01-01T00:00:00Z", [
          sourceEntry("one", "one"),
        ])
      )
      let stateReads = 0
      getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
        beforeRead(boundary) {
          if (boundary === "state.read") stateReads += 1
        },
      })

      const operations = Array.from({ length: operationCount }, (_, index) => ({
        id: `patch-${index}`,
        kind: "object.patch" as const,
        ref: ref("one"),
        set: { note: String(index) },
        unset: [],
        reset: [],
      }))
      const result = await materializer.edits.commit(
        atomic(`edit-read-scale-${operationCount}`, operations)
      )

      expect(result.outcomes).toHaveLength(operationCount)
      expect(stateReads).toBe(1)
    }
  })

  test("persists canonical event envelopes, removals, ordering, partitions, and ids", async () => {
    const { materializer, storage } = createMaterializerFixture()
    const created = await materializer.edits.commit(
      atomic("event-envelope", [
        {
          id: "b",
          kind: "object.create",
          ref: ref("b"),
          properties: { name: "b" },
        },
        {
          id: "a",
          kind: "object.create",
          ref: ref("a"),
          properties: { name: "a", note: "remove-me" },
        },
        {
          id: "link",
          kind: "link.upsert",
          ref: { source: ref("a"), linkId: "parent", target: ref("b") },
        },
      ])
    )
    const rows = await storage.ontology.outbox.claim({
      projectId: "project",
      now: "2027-01-01T00:00:00.000Z",
      limit: 10,
      leaseId: "event-lease",
      leaseExpiresAt: "2027-01-01T01:00:00.000Z",
    })
    const envelopes = rows
      .map((row) => row.envelope)
      .filter((event) => event.commitId === created.commitId)
      .sort((left, right) => left.commitOrdinal - right.commitOrdinal)
    expect(envelopes.map((event) => event.type)).toEqual([
      "object.created",
      "object.created",
      "link.created",
    ])
    expect(envelopes.map((event) => event.commitOrdinal)).toEqual([0, 1, 2])
    expect(envelopes.map((event) => event.partitionKey)).toEqual([
      "Device:a",
      "Device:b",
      "Device:a:parent",
    ])
    expect(envelopes.map((event) => event.id)).toEqual(
      [0, 1, 2].map((ordinal) => createEventId("project", created.commitId, ordinal))
    )
    await storage.ontology.outbox.markPublished({
      projectId: "project",
      ids: rows.map((row) => row.envelope.id),
      leaseId: "event-lease",
      publishedAt: "2027-01-01T00:30:00.000Z",
    })

    const updated = await materializer.edits.commit(
      atomic("event-removal", [
        {
          id: "unset-note",
          kind: "object.patch",
          ref: ref("a"),
          set: {},
          unset: ["note"],
          reset: [],
        },
      ])
    )
    const [removal] = await storage.ontology.outbox.claim({
      projectId: "project",
      now: "2027-01-02T00:00:00.000Z",
      limit: 10,
      leaseId: "removal-lease",
      leaseExpiresAt: "2027-01-02T01:00:00.000Z",
    })
    expect(removal.envelope).toMatchObject({
      id: createEventId("project", updated.commitId, 0),
      type: "object.updated",
      partitionKey: "Device:a",
      payload: {
        properties: { name: "a" },
        propertyChanges: {
          note: { operation: "cleared", before: "remove-me", after: null },
        },
      },
    })
  })
})
