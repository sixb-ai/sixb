import { describe, expect, test } from "bun:test"
import { defineObjectType, InMemoryStorage, link, OntologyRegistry, prop } from "../src"
import {
  createEventId,
  createLinkScopeFingerprint,
  createOntologyMaterializer,
  ProjectionRegistry,
} from "../src/materializer"
import { planWork } from "../src/materializer/execution/work-records"
import {
  type MaterializationPlanChunk,
  type MaterializationPlanFinalization,
  type MaterializationPlanHeader,
  type MaterializationPlanWorkItem,
  type OntologyCommitRecord,
  type OntologyCommitWrite,
  StorageTransactionError,
} from "../src/storage"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import {
  atomic,
  createMaterializerFixture,
  pendingProjectionExecution,
  replacement,
  sourceEntry,
} from "./materializer-fixture"

describe("in-memory ontology storage", () => {
  test("uniquely indexes authoritative commits by logical Action and projection origin", async () => {
    const { materializer, storage } = createMaterializerFixture()

    const replacementResult = await materializer.projections.replace(
      replacement("origin-unique", "2026-01-01T00:00:00Z", [sourceEntry("one", "one")])
    )
    const replacementCommit = await storage.ontology.commits.getByOrigin({
      projectId: "project",
      origin: { kind: "projection", projectionRunId: "run-origin-unique" },
    })
    expect(replacementCommit?.id).toBe(replacementResult.commitId)
    await expectLogicalOriginDuplicateRejected(storage, replacementCommit)

    await storage.actionRuns.queue({
      id: "origin-action-run",
      projectId: "project",
      actionId: "noop",
      subject: { kind: "none" },
      params: {},
      idempotencyKey: "action:origin-action-run",
    })
    await storage.actionRuns.start({ id: "origin-action-run", projectId: "project" })
    const actionResult = await materializer.edits.commit({
      mode: "atomic",
      source: { kind: "action", actionId: "noop", runId: "origin-action-run" },
      operations: [],
      expectedObjects: [],
      expectedLinks: [],
      expectedLinkScopes: [],
    })
    const actionCommit = await storage.ontology.commits.getByOrigin({
      projectId: "project",
      origin: { kind: "action", actionRunId: "origin-action-run" },
    })
    expect(actionCommit?.id).toBe(actionResult.commitId)
    await expectLogicalOriginDuplicateRejected(storage, actionCommit)

    const telemetryResult = await materializer.telemetry.append({
      source: {
        kind: "projection",
        projection: { projectionId: "temperatures" },
        datasetVersion: {
          datasetId: "readings",
          versionId: "origin-telemetry",
          createdAt: "2026-01-01T00:00:00Z",
        },
        execution: pendingProjectionExecution("origin-telemetry-run"),
        batchOrdinal: 0,
        sourceRowCount: 1,
        inputExhausted: true,
      },
      points: [
        {
          series: {
            object: { objectTypeId: "Device", primaryId: "one" },
            propertyId: "temperature",
          },
          value: 20,
          at: "2026-01-01T01:00:00Z",
        },
      ],
    })
    const telemetryCommit = await storage.ontology.commits.getByOrigin({
      projectId: "project",
      origin: {
        kind: "telemetry",
        projectionRunId: "origin-telemetry-run",
        batchOrdinal: 0,
      },
    })
    expect(telemetryCommit?.id).toBe(telemetryResult.commitId)
    await expectLogicalOriginDuplicateRejected(storage, telemetryCommit)
  })

  test("isolates replacement heads and incident override scans by project", async () => {
    const fixture = createMaterializerFixture()
    const { storage, ontology, projections, materializer } = fixture
    let otherMaterialization = 0
    const other = createOntologyMaterializer({
      projectId: "other-project",
      ontology,
      projections,
      storage: storage as typeof storage & { ontology: NonNullable<typeof storage.ontology> },
      dependencies: {
        clock: () => new Date("2026-01-03T00:00:00Z"),
        materializationId: () => `other-materialization-${++otherMaterialization}`,
      },
    })
    await materializer.projections.replace(
      replacement("project-v1", "2026-01-01T00:00:00Z", [sourceEntry("hub", "hub")])
    )
    const otherReplacement = replacement("other-v1", "2026-01-01T00:00:00Z", [
      sourceEntry("other", "other"),
    ])
    const otherExecution = await claimReplacementExecution(storage, projections, {
      projectId: "other-project",
      runId: otherReplacement.execution.projectionRunId,
      datasetVersion: otherReplacement.datasetVersion,
    })
    await other.projections.replace({ ...otherReplacement, execution: otherExecution })
    expect(
      (
        await storage.ontology.sources.getActive({
          projectId: "project",
          source: { projectionId: "devices" },
        })
      )?.datasetVersion.versionId
    ).toBe("project-v1")
    expect(
      (
        await storage.ontology.sources.getActive({
          projectId: "other-project",
          source: { projectionId: "devices" },
        })
      )?.datasetVersion.versionId
    ).toBe("other-v1")

    await other.edits.commit(
      atomic("other-incident-authority", [
        {
          id: "hub",
          kind: "object.create",
          ref: { objectTypeId: "Device", primaryId: "hub" },
          properties: { name: "other hub" },
        },
        {
          id: "target",
          kind: "object.create",
          ref: { objectTypeId: "Device", primaryId: "other-target" },
          properties: { name: "other target" },
        },
        {
          id: "link",
          kind: "link.upsert",
          ref: {
            source: { objectTypeId: "Device", primaryId: "hub" },
            linkId: "parent",
            target: { objectTypeId: "Device", primaryId: "other-target" },
          },
        },
      ])
    )
    const removed = await materializer.projections.replace(
      replacement("project-v2", "2026-01-02T00:00:00Z", [])
    )
    expect(removed.counts).toMatchObject({ objectsDeleted: 1, linksUnchanged: 0 })
  })

  test("rolls back exact object, ontology, outbox, and activation writes on injected failure", async () => {
    let fail = true
    const storage = new InMemoryStorage()
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      beforeWrite(boundary) {
        if (fail && boundary === "finalize") throw new Error("injected finalize failure")
      },
    })
    const { materializer } = createMaterializerFixture({ storage })
    await expect(
      materializer.projections.replace(
        replacement("v1", "2026-01-01T00:00:00Z", [sourceEntry("one", "one")])
      )
    ).rejects.toThrow("injected finalize failure")
    expect(
      await storage.objects.getByPrimaryId({
        projectId: "project",
        objectTypeId: "Device",
        primaryId: "one",
      })
    ).toBeNull()
    expect(
      await storage.ontology.sources.getActive({
        projectId: "project",
        source: { projectionId: "devices" },
      })
    ).toBeNull()
    expect(
      await storage.ontology.outbox.claim({
        projectId: "project",
        now: "2027-01-01T00:00:00Z",
        limit: 10,
        leaseId: "lease",
        leaseExpiresAt: "2027-01-01T01:00:00Z",
      })
    ).toEqual([])

    fail = false
    await materializer.projections.replace(
      replacement("v1", "2026-01-01T00:00:00Z", [sourceEntry("one", "one")])
    )
    expect(
      await storage.objects.getByPrimaryId({
        projectId: "project",
        objectTypeId: "Device",
        primaryId: "one",
      })
    ).not.toBeNull()
  })

  test("rolls back at every exact-plan write category", async () => {
    const boundaries = [
      "override.object.upsert",
      "override.object.delete",
      "override.link.upsert",
      "override.link.delete",
      "effective.object.upsert",
      "effective.object.delete",
      "effective.link.upsert",
      "effective.link.delete",
      "timeseries.point.upsert",
      "outbox.insert",
      "source.activate",
      "finalize",
    ] as const

    for (const boundary of boundaries) {
      let failBoundary: string | null = null
      const storage = new InMemoryStorage()
      getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
        beforeWrite(current) {
          if (current === failBoundary) throw new Error(`injected ${current}`)
        },
      })
      const { materializer } = createMaterializerFixture({ storage })
      const object = (id: string) => ({ objectTypeId: "Device", primaryId: id })
      const commit = (
        requestId: string,
        operations: Parameters<typeof materializer.edits.commit>[0]["operations"]
      ) =>
        materializer.edits.commit({
          mode: "atomic",
          source: { kind: "runtime", requestId },
          operations,
          expectedObjects: [],
          expectedLinks: [],
          expectedLinkScopes: [],
        })

      if (boundary.includes("delete")) {
        await commit("prepare-objects", [
          {
            id: "one",
            kind: "object.create",
            ref: object("one"),
            properties: { name: "one" },
          },
          {
            id: "two",
            kind: "object.create",
            ref: object("two"),
            properties: { name: "two" },
          },
        ])
        if (boundary.includes("link")) {
          await commit("prepare-link", [
            {
              id: "link",
              kind: "link.upsert",
              ref: {
                source: object("one"),
                linkId: "parent",
                target: object("two"),
              },
            },
          ])
        }
      } else if (boundary.includes("link")) {
        await commit("prepare-objects", [
          {
            id: "one",
            kind: "object.create",
            ref: object("one"),
            properties: { name: "one" },
          },
          {
            id: "two",
            kind: "object.create",
            ref: object("two"),
            properties: { name: "two" },
          },
        ])
      } else if (boundary === "timeseries.point.upsert") {
        await commit("prepare-telemetry-object", [
          {
            id: "one",
            kind: "object.create",
            ref: object("one"),
            properties: { name: "one" },
          },
        ])
      }

      const before = {
        objects: storage.objects.snapshot(),
        timeseries: storage.timeseries.snapshot(),
        ontology: getInMemoryOntologyStorageTestingAdapter(storage.ontology).snapshot(),
      }
      failBoundary = boundary
      const attempt =
        boundary === "source.activate"
          ? materializer.projections.replace(
              replacement("activation", "2026-01-01T00:00:00Z", [sourceEntry("one", "one")])
            )
          : boundary === "timeseries.point.upsert"
            ? materializer.telemetry.append({
                source: { kind: "runtime", requestId: `fail-${boundary}` },
                points: [
                  {
                    series: {
                      object: object("one"),
                      propertyId: "temperature",
                    },
                    value: 20,
                    at: "2026-01-01T00:00:00Z",
                  },
                ],
              })
            : boundary.includes("link")
              ? commit(`fail-${boundary}`, [
                  {
                    id: "link",
                    kind: boundary.includes("delete") ? "link.delete" : "link.upsert",
                    ref: {
                      source: object("one"),
                      linkId: "parent",
                      target: object("two"),
                    },
                  },
                ])
              : commit(`fail-${boundary}`, [
                  {
                    id: "object",
                    kind: boundary.includes("delete") ? "object.delete" : "object.create",
                    ref: object(boundary.includes("delete") ? "one" : "created"),
                    ...(boundary.includes("delete") ? {} : { properties: { name: "created" } }),
                  } as Parameters<typeof commit>[1][number],
                ])
      await expect(attempt).rejects.toThrow(`injected ${boundary}`)
      expect(storage.objects.snapshot()).toEqual(before.objects)
      expect(storage.timeseries.snapshot()).toEqual(before.timeseries)
      const afterOntology = getInMemoryOntologyStorageTestingAdapter(storage.ontology).snapshot()
      if (boundary === "source.activate") {
        expect({
          ...afterOntology,
          sourceMaterializations: before.ontology.sourceMaterializations,
        }).toEqual(before.ontology)
        expect(
          [...afterOntology.sourceMaterializations.values()].map(({ status }) => status)
        ).toEqual(["ready"])
        expect(
          await storage.ontology.sources.getActive({
            projectId: "project",
            source: { projectionId: "devices" },
          })
        ).toBeNull()
      } else {
        expect(afterOntology).toEqual(before.ontology)
      }
    }
  })

  test("correlates and closes provider sessions and supports outbox lease lifecycle", async () => {
    const storage = new InMemoryStorage()
    const header = {
      commit: {
        projectId: "project",
        id: "commit",
        idempotencyKey: "runtime:empty",
        requestHash: "hash",
        origin: { kind: "runtime", requestId: "empty" },
        ontologyRevision: "revision",
        intent: { kind: "edit", mode: "atomic", operationCount: 0 },
        committedAt: "2026-01-01T00:00:00.000Z",
      },
      expected: {
        sources: [],
        objects: [],
        links: [],
        linkScopes: [],
        points: [],
      },
    } satisfies MaterializationPlanHeader
    await storage.transaction(async (tx) => {
      if (!tx.ontology) throw new Error("missing ontology")
      const session = await tx.ontology.materializations.begin(header)
      await tx.ontology.materializations.finalize({
        session,
        finalization: {
          sourceActivations: [],
          result: {
            kind: "edit",
            commitId: "commit",
            created: true,
            eventCount: 0,
            outcomes: [],
            changes: { objects: [], links: [] },
          },
        },
      })
      await expect(
        tx.ontology.materializations.applyChunk({
          session,
          chunk: {
            overrides: {
              objectUpserts: [],
              objectDeletes: [],
              linkUpserts: [],
              linkDeletes: [],
            },
            effective: {
              objectUpserts: [],
              objectDeletes: [],
              linkUpserts: [],
              linkDeletes: [],
            },
            timeseries: { pointUpserts: [] },
            outbox: [],
          },
        })
      ).rejects.toThrow("inactive")
    })

    const { materializer } = createMaterializerFixture({ storage })
    await materializer.edits.commit({
      mode: "atomic",
      source: { kind: "runtime", requestId: "object" },
      operations: [
        {
          id: "create",
          kind: "object.create",
          ref: { objectTypeId: "Device", primaryId: "one" },
          properties: { name: "one" },
        },
      ],
      expectedObjects: [],
      expectedLinks: [],
      expectedLinkScopes: [],
    })
    const claimed = await storage.ontology.outbox.claim({
      projectId: "project",
      now: "2027-01-01T00:00:00Z",
      limit: 10,
      leaseId: "lease",
      leaseExpiresAt: "2027-01-01T01:00:00Z",
    })
    expect(claimed).toHaveLength(1)
    await storage.ontology.outbox.reschedule({
      projectId: "project",
      ids: [claimed[0].envelope.id],
      leaseId: "lease",
      availableAt: "2027-01-02T00:00:00Z",
      error: "broker down",
    })
    const reclaimed = await storage.ontology.outbox.claim({
      projectId: "project",
      now: "2027-01-03T00:00:00Z",
      limit: 10,
      leaseId: "lease-2",
      leaseExpiresAt: "2027-01-03T01:00:00Z",
    })
    await storage.ontology.outbox.markPublished({
      projectId: "project",
      ids: [reclaimed[0].envelope.id],
      leaseId: "lease-2",
      publishedAt: "2027-01-03T00:30:00Z",
    })
    expect(
      await storage.ontology.outbox.purgePublished({
        projectId: "project",
        publishedBefore: "2027-01-04T00:00:00Z",
        limit: 10,
      })
    ).toBe(1)
  })

  test("requires transaction-scoped sessions and invalidates unfinished sessions after commit", async () => {
    const storage = new InMemoryStorage()
    const header = {
      commit: {
        projectId: "project",
        id: "session-lifecycle",
        idempotencyKey: "runtime:session-lifecycle",
        requestHash: "hash",
        origin: { kind: "runtime", requestId: "session-lifecycle" },
        ontologyRevision: "revision",
        intent: { kind: "edit", mode: "atomic", operationCount: 0 },
        committedAt: "2026-01-01T00:00:00.000Z",
      },
      expected: {
        sources: [],
        objects: [],
        links: [],
        linkScopes: [],
        points: [],
      },
    } satisfies MaterializationPlanHeader
    await expect(storage.ontology.materializations.begin(header)).rejects.toThrow(
      "require an active storage transaction"
    )

    let unfinished: Awaited<ReturnType<typeof storage.ontology.materializations.begin>> | null =
      null
    await storage.transaction(async (tx) => {
      if (!tx.ontology) throw new Error("missing ontology")
      unfinished = await tx.ontology.materializations.begin(header)
    })
    await expect(
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        await tx.ontology.materializations.stageWork({ session: unfinished!, records: [] })
      })
    ).rejects.toThrow("inactive")
  })

  test("serializes source staging with failed transaction snapshots", async () => {
    const storage = new InMemoryStorage()
    const { projections } = createMaterializerFixture({ storage })
    const source = { projectionId: "devices" }
    const datasetVersion = {
      datasetId: "devices",
      versionId: "concurrent",
      createdAt: "2026-01-01T00:00:00.000Z",
    }
    const execution = await claimReplacementExecution(storage, projections, {
      projectId: "project",
      runId: "concurrent-run",
      datasetVersion,
    })
    const resolved = projections.resolveSource(source.projectionId)
    await storage.ontology.sources.beginMaterialization({
      projectId: "project",
      source,
      materializationId: "concurrent-candidate",
      execution,
      projectionKind: "object",
      protocol: "replacement",
      datasetVersion,
      projectionRevision: resolved.projectionRevision,
      ownershipHash: resolved.ownershipHash,
      ontologyRevision: projections.ontologyRevision,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const transactionEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const failed = storage.transaction(async () => {
      entered()
      await blocked
      throw new Error("rollback after concurrent stage")
    })
    await transactionEntered

    let stagingFinished = false
    const row = {
      root: { kind: "object" as const, ref: { objectTypeId: "Device", primaryId: "one" } },
      assertion: {
        kind: "object" as const,
        ref: { objectTypeId: "Device", primaryId: "one" },
        properties: { name: "one" },
      },
      stagingOrdinal: 0,
    }
    const staged = storage.ontology.sources
      .stageRows({
        projectId: "project",
        source,
        materializationId: "concurrent-candidate",
        execution,
        rows: [row],
      })
      .then((result) => {
        stagingFinished = true
        return result
      })
    await Promise.resolve()
    expect(stagingFinished).toBe(false)
    release()
    await expect(failed).rejects.toThrow("rollback after concurrent stage")
    expect(await staged).toEqual({ inserted: 1, unchanged: 0 })
    expect(
      await storage.ontology.sources.stageRows({
        projectId: "project",
        source,
        materializationId: "concurrent-candidate",
        execution,
        rows: [row],
      })
    ).toEqual({ inserted: 0, unchanged: 1 })
  })

  test("stages insert-only session work atomically and drains deterministic bounded pages", async () => {
    const storage = new InMemoryStorage()
    const header = {
      commit: {
        projectId: "project",
        id: "work-commit",
        idempotencyKey: "runtime:work",
        requestHash: "work-hash",
        origin: { kind: "runtime", requestId: "work" },
        ontologyRevision: "revision",
        intent: { kind: "edit", mode: "atomic", operationCount: 0 },
        committedAt: "2026-01-01T00:00:00.000Z",
      },
      expected: {
        sources: [],
        objects: [],
        links: [],
        linkScopes: [],
        points: [],
      },
    } satisfies MaterializationPlanHeader
    let closedSession: Awaited<ReturnType<typeof storage.ontology.materializations.begin>> | null =
      null
    await storage.transaction(async (tx) => {
      if (!tx.ontology) throw new Error("missing ontology")
      const materializations = tx.ontology.materializations
      const session = await materializations.begin(header)
      closedSession = session
      const classification = {
        kind: "classification" as const,
        recordKey: "classification:object:61",
        entityKind: "object" as const,
        identityKey: '["Device","a"]',
      }
      await expect(
        materializations.stageWork({ session, records: [classification, classification] })
      ).rejects.toThrow("Duplicate materialization work key")
      await materializations.stageWork({ session, records: [classification] })
      await expect(
        materializations.stageWork({ session, records: [classification] })
      ).rejects.toThrow("Duplicate materialization work key")

      await materializations.stageWork({
        session,
        records: [
          {
            kind: "object-existence",
            recordKey: "existence:61",
            ref: { objectTypeId: "Device", primaryId: "a" },
            exists: true,
          },
          {
            kind: "plan",
            recordKey: "plan:object-upsert:62",
            applyPhase: 4,
            sortKey: "62",
            item: {
              kind: "object-upsert",
              value: {
                row: {
                  ref: { objectTypeId: "Device", primaryId: "b" },
                  properties: { name: "b" },
                  version: 1,
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  lastCommitId: "work-commit",
                },
                expected: {
                  ref: { objectTypeId: "Device", primaryId: "b" },
                  exists: false,
                },
              },
            },
          },
          {
            kind: "plan",
            recordKey: "plan:object-upsert:61",
            applyPhase: 4,
            sortKey: "61",
            item: {
              kind: "object-upsert",
              value: {
                row: {
                  ref: { objectTypeId: "Device", primaryId: "a" },
                  properties: { name: "a" },
                  version: 1,
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  lastCommitId: "work-commit",
                },
                expected: {
                  ref: { objectTypeId: "Device", primaryId: "a" },
                  exists: false,
                },
              },
            },
          },
          {
            kind: "event",
            recordKey: "event:1:62",
            eventKindRank: 1,
            sortKey: "62",
            draft: {
              schemaVersion: 1,
              projectId: "project",
              occurredAt: "2026-01-01T00:00:00.000Z",
              origin: { kind: "runtime", requestId: "work" },
              commitId: "work-commit",
              type: "object.updated",
              topic: "objects",
              partitionKey: "Device:b",
              payload: {
                objectTypeId: "Device",
                primaryId: "b",
                properties: { name: "b" },
                propertyChanges: {},
              },
            },
          },
          {
            kind: "event",
            recordKey: "event:0:61",
            eventKindRank: 0,
            sortKey: "61",
            draft: {
              schemaVersion: 1,
              projectId: "project",
              occurredAt: "2026-01-01T00:00:00.000Z",
              origin: { kind: "runtime", requestId: "work" },
              commitId: "work-commit",
              type: "object.created",
              topic: "objects",
              partitionKey: "Device:a",
              payload: {
                objectTypeId: "Device",
                primaryId: "a",
                properties: { name: "a" },
                propertyChanges: {},
              },
            },
          },
        ],
      })

      const existence = await materializations.readObjectExistence({
        session,
        refs: [
          { objectTypeId: "Device", primaryId: "missing" },
          { objectTypeId: "Device", primaryId: "a" },
        ],
      })
      expect(existence).toEqual([{ ref: { objectTypeId: "Device", primaryId: "a" }, exists: true }])
      const applyPages = []
      for await (const page of materializations.streamWork({
        session,
        order: "apply",
        pageRows: 1,
      })) {
        applyPages.push(page.records)
      }
      expect(applyPages.map((page) => page.length)).toEqual([1, 1])
      expect(
        applyPages
          .flat()
          .filter((record) => record.kind === "plan")
          .map((record) => record.sortKey)
      ).toEqual(["61", "62"])
      const objectUpserts = applyPages
        .flat()
        .flatMap((record) =>
          record.kind === "plan" && record.item.kind === "object-upsert" ? [record.item.value] : []
        )
      await materializations.applyChunk({
        session,
        chunk: {
          overrides: {
            objectUpserts: [],
            objectDeletes: [],
            linkUpserts: [],
            linkDeletes: [],
          },
          effective: {
            objectUpserts,
            objectDeletes: [],
            linkUpserts: [],
            linkDeletes: [],
          },
          timeseries: { pointUpserts: [] },
          outbox: [],
        },
      })
      const eventRecords = []
      for await (const page of materializations.streamWork({
        session,
        order: "event",
        pageRows: 1,
      })) {
        eventRecords.push(...page.records)
      }
      expect(eventRecords.map((record) => record.recordKey)).toEqual(["event:0:61", "event:1:62"])
      await materializations.applyChunk({
        session,
        chunk: {
          overrides: {
            objectUpserts: [],
            objectDeletes: [],
            linkUpserts: [],
            linkDeletes: [],
          },
          effective: {
            objectUpserts: [],
            objectDeletes: [],
            linkUpserts: [],
            linkDeletes: [],
          },
          timeseries: { pointUpserts: [] },
          outbox: eventRecords.map((record, commitOrdinal) => {
            if (record.kind !== "event") throw new Error("Expected event work")
            return {
              envelope: {
                ...record.draft,
                id: createEventId("project", "work-commit", commitOrdinal),
                commitOrdinal,
              },
              availableAt: "2026-01-01T00:00:00.000Z",
              createdAt: "2026-01-01T00:00:00.000Z",
            }
          }),
        },
      })
      await expect(
        materializations.stageWork({
          session,
          records: [
            {
              kind: "classification",
              recordKey: "classification:object:63",
              entityKind: "object",
              identityKey: '["Device","c"]',
            },
          ],
        })
      ).rejects.toThrow("after draining begins")

      await materializations.finalize({
        session,
        finalization: {
          sourceActivations: [],
          result: {
            kind: "edit",
            commitId: "work-commit",
            created: true,
            eventCount: 2,
            outcomes: [],
            changes: { objects: [], links: [] },
          },
        },
      })
      await expect(materializations.stageWork({ session, records: [] })).rejects.toThrow("inactive")
    })
    const stream = storage.ontology.materializations.streamWork({
      session: closedSession!,
      order: "apply",
      pageRows: 1,
    })
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow("inactive")
  })

  test("deactivates every live materialization session on rollback", async () => {
    const storage = new InMemoryStorage()
    let leakedSession: Awaited<ReturnType<typeof storage.ontology.materializations.begin>> | null =
      null
    await expect(
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        leakedSession = await tx.ontology.materializations.begin({
          commit: {
            projectId: "project",
            id: "rolled-back-session",
            idempotencyKey: "runtime:rolled-back-session",
            requestHash: "hash",
            origin: { kind: "runtime", requestId: "rolled-back-session" },
            ontologyRevision: "revision",
            intent: { kind: "edit", mode: "atomic", operationCount: 0 },
            committedAt: "2026-01-01T00:00:00.000Z",
          },
          expected: {
            sources: [],
            objects: [],
            links: [],
            linkScopes: [],
            points: [],
          },
        })
        await tx.ontology.materializations.stageWork({
          session: leakedSession,
          records: [
            {
              kind: "classification",
              recordKey: "classification:object:61",
              entityKind: "object",
              identityKey: '["Device","a"]',
            },
          ],
        })
        throw new Error("rollback session")
      })
    ).rejects.toThrow("rollback session")
    await expect(
      storage.ontology.materializations.applyChunk({
        session: leakedSession!,
        chunk: {
          overrides: {
            objectUpserts: [],
            objectDeletes: [],
            linkUpserts: [],
            linkDeletes: [],
          },
          effective: {
            objectUpserts: [],
            objectDeletes: [],
            linkUpserts: [],
            linkDeletes: [],
          },
          timeseries: { pointUpserts: [] },
          outbox: [],
        },
      })
    ).rejects.toThrow("inactive")
    await expect(
      storage.ontology.materializations.stageWork({ session: leakedSession!, records: [] })
    ).rejects.toThrow("inactive")
  })

  test("uses the ontology commit origin as replacement run attribution", async () => {
    const storage = new InMemoryStorage()
    const { materializer } = createMaterializerFixture({ storage })
    const input = replacement(
      "successful-version",
      "2026-01-02T00:00:00Z",
      [sourceEntry("one", "one")],
      "successful-run"
    )
    const result = await materializer.projections.replace(input)
    const run = await storage.projectionRuns.getById({
      projectId: "project",
      id: "successful-run",
    })
    expect(run).not.toHaveProperty("replacementCommitId")
    expect(run).not.toHaveProperty("materializationCounters")

    const commit = await storage.ontology.commits.getById({
      projectId: "project",
      id: result.commitId,
    })
    expect(commit?.origin).toEqual({
      kind: "projection",
      projectionId: "devices",
      projectionRunId: "successful-run",
      datasetId: "devices",
      datasetVersionId: "successful-version",
    })
    expect(commit?.result).toEqual(result)
    await expect(
      storage.ontology.commits.list({
        projectId: "project",
        run: { kind: "projection", id: "successful-run" },
      })
    ).resolves.toMatchObject({ commits: [{ id: result.commitId }], total: 1, hasMore: false })

    const replay = await materializer.projections.replace({
      ...input,
      entries: replacement("ignored", "2026-01-02T00:00:00Z", [sourceEntry("ignored", "ignored")])
        .entries,
    })
    expect(replay.created).toBe(false)
  })

  test("keeps Action materialization history exclusively in ontology commits", async () => {
    const storage = new InMemoryStorage()
    const { materializer } = createMaterializerFixture({ storage })
    await storage.actionRuns.queue({
      id: "action-materialization-run",
      projectId: "project",
      actionId: "createDevice",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "one" },
      params: {},
      idempotencyKey: "action:project:action-materialization-run",
    })
    await storage.actionRuns.start({ id: "action-materialization-run", projectId: "project" })
    const input = {
      mode: "atomic" as const,
      source: {
        kind: "action" as const,
        actionId: "createDevice",
        runId: "action-materialization-run",
      },
      operations: [
        {
          id: "create",
          kind: "object.create" as const,
          ref: { objectTypeId: "Device", primaryId: "one" },
          properties: { name: "one" },
        },
      ],
      expectedObjects: [],
      expectedLinks: [],
      expectedLinkScopes: [],
    }

    const committed = await materializer.edits.commit(input)
    expect(
      await storage.actionRuns.getById({ projectId: "project", id: "action-materialization-run" })
    ).not.toHaveProperty("commitId")
    await expect(
      storage.ontology.commits.list({
        projectId: "project",
        run: { kind: "action", id: "action-materialization-run" },
      })
    ).resolves.toMatchObject({
      commits: [{ id: committed.commitId, origin: { kind: "action" } }],
      total: 1,
      hasMore: false,
    })
    expect((await materializer.edits.commit(input)).created).toBe(false)
  })

  test("reclaims expired outbox leases in parent-spec createdAt and event-id order", async () => {
    const times = [new Date("2026-01-01T00:00:00Z"), new Date("2026-01-02T00:00:00Z")]
    const { materializer, storage } = createMaterializerFixture({
      dependencies: { clock: () => times.shift() ?? new Date("2026-01-03T00:00:00Z") },
    })
    await materializer.edits.commit(
      atomic("outbox-first", [
        {
          id: "b",
          kind: "object.create",
          ref: { objectTypeId: "Device", primaryId: "b" },
          properties: { name: "b" },
        },
        {
          id: "a",
          kind: "object.create",
          ref: { objectTypeId: "Device", primaryId: "a" },
          properties: { name: "a" },
        },
      ])
    )
    await materializer.edits.commit(
      atomic("outbox-second", [
        {
          id: "c",
          kind: "object.create",
          ref: { objectTypeId: "Device", primaryId: "c" },
          properties: { name: "c" },
        },
      ])
    )
    const claimed = await storage.ontology.outbox.claim({
      projectId: "project",
      now: "2026-01-03T00:00:00Z",
      limit: 10,
      leaseId: "lease-1",
      leaseExpiresAt: "2026-01-03T01:00:00Z",
    })
    expect(claimed.map((row) => row.createdAt)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ])
    expect(claimed.slice(0, 2).map((row) => row.envelope.id)).toEqual(
      claimed
        .slice(0, 2)
        .map((row) => row.envelope.id)
        .sort()
    )
    expect(
      await storage.ontology.outbox.claim({
        projectId: "project",
        now: "2026-01-03T00:30:00Z",
        limit: 10,
        leaseId: "lease-early",
        leaseExpiresAt: "2026-01-03T01:30:00Z",
      })
    ).toEqual([])
    const reclaimed = await storage.ontology.outbox.claim({
      projectId: "project",
      now: "2026-01-03T02:00:00Z",
      limit: 10,
      leaseId: "lease-2",
      leaseExpiresAt: "2026-01-03T03:00:00Z",
    })
    const ids = reclaimed.map((row) => row.envelope.id)
    await expect(
      storage.ontology.outbox.markPublished({
        projectId: "project",
        ids,
        leaseId: "lease-1",
        publishedAt: "2026-01-03T02:30:00Z",
      })
    ).rejects.toThrow("lease does not match")
    await expect(
      storage.ontology.outbox.reschedule({
        projectId: "project",
        ids,
        leaseId: "lease-1",
        availableAt: "2026-01-04T00:00:00Z",
        error: "stale",
      })
    ).rejects.toThrow("lease does not match")
    await expect(
      storage.ontology.outbox.markPublished({
        projectId: "project",
        ids: [ids[0], "missing"],
        leaseId: "lease-2",
        publishedAt: "2026-01-03T02:30:00Z",
      })
    ).rejects.toThrow("lease does not match")
    await storage.ontology.outbox.markPublished({
      projectId: "project",
      ids,
      leaseId: "lease-2",
      publishedAt: "2026-01-03T02:30:00Z",
    })
    expect(
      await storage.ontology.outbox.purgePublished({
        projectId: "project",
        publishedBefore: "2026-01-04T00:00:00Z",
        limit: 2,
      })
    ).toBe(2)
    expect(
      await storage.ontology.outbox.purgePublished({
        projectId: "project",
        publishedBefore: "2026-01-04T00:00:00Z",
        limit: 2,
      })
    ).toBe(1)
  })

  test("checks exact link, link-scope, and point CAS dependencies", async () => {
    const { materializer, storage, projections } = createMaterializerFixture()
    await materializer.edits.commit(
      atomic("cas-objects", [
        {
          id: "one",
          kind: "object.create",
          ref: { objectTypeId: "Device", primaryId: "one" },
          properties: { name: "one" },
        },
        {
          id: "two",
          kind: "object.create",
          ref: { objectTypeId: "Device", primaryId: "two" },
          properties: { name: "two" },
        },
        {
          id: "link",
          kind: "link.upsert",
          ref: {
            source: { objectTypeId: "Device", primaryId: "one" },
            linkId: "parent",
            target: { objectTypeId: "Device", primaryId: "two" },
          },
        },
      ])
    )
    await materializer.telemetry.append({
      source: { kind: "runtime", requestId: "cas-point" },
      points: [
        {
          series: {
            object: { objectTypeId: "Device", primaryId: "one" },
            propertyId: "temperature",
          },
          value: 20,
          at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    await materializer.projections.replace(
      replacement("cas-source", "2026-01-02T00:00:00Z", [
        sourceEntry("one", "source-one"),
        sourceEntry("two", "source-two"),
      ])
    )
    const linkRef = {
      source: { objectTypeId: "Device", primaryId: "one" },
      linkId: "parent",
      target: { objectTypeId: "Device", primaryId: "two" },
    }
    const active = await storage.ontology.sources.getActive({
      projectId: "project",
      source: { projectionId: "devices" },
    })
    const objectOne = await storage.objects.getByPrimaryId({
      projectId: "project",
      objectTypeId: "Device",
      primaryId: "one",
    })
    const pointOne = await storage.timeseries.getLatest({
      projectId: "project",
      objectTypeId: "Device",
      objectId: "one",
      propertyId: "temperature",
    })
    const linkOne = (
      await storage.objects.listLinks({
        projectId: "project",
        objectTypeId: "Device",
        objectId: "one",
      })
    ).find((row) => row.linkId === "parent")
    if (!active || !objectOne?.lastCommitId || !linkOne?.lastCommitId || !pointOne?.lastCommitId) {
      throw new Error("CAS fixture state was not materialized")
    }
    const objectLastCommitId = objectOne.lastCommitId
    const linkLastCommitId = linkOne.lastCommitId
    const pointLastCommitId = pointOne.lastCommitId
    const baseHeader = (id: string): MaterializationPlanHeader => ({
      commit: {
        projectId: "project",
        id,
        idempotencyKey: `runtime:${id}`,
        requestHash: id,
        origin: { kind: "runtime", requestId: id },
        ontologyRevision: projections.ontologyRevision,
        intent: { kind: "edit", mode: "atomic", operationCount: 0 },
        committedAt: "2026-01-04T00:00:00.000Z",
      },
      expected: {
        sources: [],
        objects: [],
        links: [],
        linkScopes: [],
        points: [],
      },
    })
    const expectBeginConflict = async (header: MaterializationPlanHeader, message: string) => {
      await storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        await expect(tx.ontology.materializations.begin(header)).rejects.toThrow(message)
      })
    }
    await expectBeginConflict(
      {
        ...baseHeader("bad-source"),
        expected: {
          ...baseHeader("bad-source").expected,
          sources: [
            {
              source: { projectionId: "devices" },
              activeMaterializationId: active.materializationId,
              lastCommitId: "stale",
            },
          ],
        },
      },
      "Source 'devices' changed"
    )
    await expectBeginConflict(
      {
        ...baseHeader("object-was-present"),
        expected: {
          ...baseHeader("object-was-present").expected,
          objects: [{ ref: linkRef.source, exists: false }],
        },
      },
      "to be absent"
    )
    await expectBeginConflict(
      {
        ...baseHeader("object-was-absent"),
        expected: {
          ...baseHeader("object-was-absent").expected,
          objects: [
            {
              ref: { objectTypeId: "Device", primaryId: "missing" },
              exists: true,
              version: 1,
              lastCommitId: "missing",
            },
          ],
        },
      },
      "Expected object"
    )
    await expectBeginConflict(
      {
        ...baseHeader("link-was-present"),
        expected: {
          ...baseHeader("link-was-present").expected,
          links: [{ ref: linkRef, exists: false }],
        },
      },
      "to be absent"
    )
    await expectBeginConflict(
      {
        ...baseHeader("link-was-absent"),
        expected: {
          ...baseHeader("link-was-absent").expected,
          links: [
            {
              ref: { ...linkRef, target: { objectTypeId: "Device", primaryId: "missing" } },
              exists: true,
              lastCommitId: "missing",
            },
          ],
        },
      },
      "Expected link"
    )
    await expectBeginConflict(
      {
        ...baseHeader("bad-link"),
        expected: {
          ...baseHeader("bad-link").expected,
          links: [{ ref: linkRef, exists: true, lastCommitId: "stale" }],
        },
      },
      "Expected link"
    )
    await expectBeginConflict(
      {
        ...baseHeader("bad-scope"),
        expected: {
          ...baseHeader("bad-scope").expected,
          linkScopes: [
            {
              source: linkRef.source,
              linkId: "parent",
              fingerprint: "stale",
            },
          ],
        },
      },
      "Expected link scope changed"
    )
    await expectBeginConflict(
      {
        ...baseHeader("bad-point"),
        expected: {
          ...baseHeader("bad-point").expected,
          points: [
            {
              series: { object: linkRef.source, propertyId: "temperature" },
              at: "2026-01-01T00:00:00.000Z",
              lastCommitId: "stale",
            },
          ],
        },
      },
      "Telemetry point"
    )

    await storage.transaction(async (tx) => {
      if (!tx.ontology) throw new Error("missing ontology")
      const session = await tx.ontology.materializations.begin({
        ...baseHeader("valid-cas"),
        expected: {
          ...baseHeader("valid-cas").expected,
          sources: [
            {
              source: { projectionId: "devices" },
              activeMaterializationId: active.materializationId,
              lastCommitId: active.lastCommitId,
            },
          ],
          objects: [
            {
              ref: linkRef.source,
              exists: true,
              version: objectOne.version,
              lastCommitId: objectLastCommitId,
            },
            { ref: { objectTypeId: "Device", primaryId: "missing" }, exists: false },
          ],
          links: [
            { ref: linkRef, exists: true, lastCommitId: linkLastCommitId },
            {
              ref: { ...linkRef, target: { objectTypeId: "Device", primaryId: "missing" } },
              exists: false,
            },
          ],
          points: [
            {
              series: { object: linkRef.source, propertyId: "temperature" },
              at: "2026-01-01T00:00:00.000Z",
              lastCommitId: pointLastCommitId,
            },
            {
              series: { object: linkRef.source, propertyId: "temperature" },
              at: "2026-01-01T01:00:00.000Z",
              lastCommitId: null,
            },
          ],
        },
      })
      await tx.ontology.materializations.finalize({
        session,
        finalization: {
          sourceActivations: [],
          result: {
            kind: "edit",
            commitId: "valid-cas",
            created: true,
            eventCount: 0,
            outcomes: [],
            changes: { objects: [], links: [] },
          },
        },
      })
    })
  })

  test("uses canonical UTF-8 link ordering for non-BMP/BMP link-scope CAS", async () => {
    const UnicodeNode = defineObjectType({
      id: "UnicodeNode",
      name: "Unicode Node",
      properties: [
        prop("id", "string", { primary: true, required: true }),
        prop("name", "string", { required: true }),
      ],
      links: [link.self("neighbors", { cardinality: "many" })],
    })
    const ontology = new OntologyRegistry({ sources: [UnicodeNode] })
    const projections = new ProjectionRegistry({
      projections: [],
      ontology,
      datasetsById: new Map(),
    })
    const storage = new InMemoryStorage()
    const materializer = createOntologyMaterializer({
      projectId: "unicode-project",
      ontology,
      projections,
      storage,
      dependencies: { clock: () => new Date("2026-01-01T00:00:00Z") },
    })
    const object = (primaryId: string) => ({ objectTypeId: "UnicodeNode", primaryId })
    await materializer.edits.commit({
      mode: "atomic",
      source: { kind: "runtime", requestId: "unicode-links" },
      operations: [
        ...["source", "\uE000", "😀"].map((primaryId) => ({
          id: `object-${primaryId}`,
          kind: "object.create" as const,
          ref: object(primaryId),
          properties: { name: primaryId },
        })),
        ...["\uE000", "😀"].map((primaryId) => ({
          id: `link-${primaryId}`,
          kind: "link.upsert" as const,
          ref: { source: object("source"), linkId: "neighbors", target: object(primaryId) },
        })),
      ],
      expectedObjects: [],
      expectedLinks: [],
      expectedLinkScopes: [],
    })
    const rows = await storage.objects.listLinks({
      projectId: "unicode-project",
      objectTypeId: "UnicodeNode",
      objectId: "source",
      linkId: "neighbors",
    })
    const fingerprint = createLinkScopeFingerprint(
      rows.map((row) => ({
        ref: {
          source: object(row.sourceId),
          linkId: row.linkId,
          target: object(row.targetId),
        },
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        lastCommitId: row.lastCommitId!,
      }))
    )
    await storage.transaction(async (tx) => {
      if (!tx.ontology) throw new Error("missing ontology")
      const session = await tx.ontology.materializations.begin({
        commit: {
          projectId: "unicode-project",
          id: "unicode-cas",
          idempotencyKey: "runtime:unicode-cas",
          requestHash: "unicode-cas",
          origin: { kind: "runtime", requestId: "unicode-cas" },
          ontologyRevision: projections.ontologyRevision,
          intent: { kind: "edit", mode: "atomic", operationCount: 0 },
          committedAt: "2026-01-02T00:00:00.000Z",
        },
        expected: {
          sources: [],
          objects: [],
          links: [],
          linkScopes: [{ source: object("source"), linkId: "neighbors", fingerprint }],
          points: [],
        },
      })
      await tx.ontology.materializations.finalize({
        session,
        finalization: {
          sourceActivations: [],
          result: {
            kind: "edit",
            commitId: "unicode-cas",
            created: true,
            eventCount: 0,
            outcomes: [],
            changes: { objects: [], links: [] },
          },
        },
      })
    })
  })

  test("rejects exact plan identity and provenance mismatches before mutation", async () => {
    const storage = new InMemoryStorage()
    const objectA = { objectTypeId: "Device", primaryId: "a" }
    const objectB = { objectTypeId: "Device", primaryId: "b" }
    const linkA = { source: objectA, linkId: "parent", target: objectB }
    const linkB = { source: objectA, linkId: "parent", target: objectA }
    const committedAt = "2026-01-01T00:00:00.000Z"
    const chunk = (): DeepMutable<MaterializationPlanChunk> => ({
      overrides: { objectUpserts: [], objectDeletes: [], linkUpserts: [], linkDeletes: [] },
      effective: { objectUpserts: [], objectDeletes: [], linkUpserts: [], linkDeletes: [] },
      timeseries: { pointUpserts: [] },
      outbox: [],
    })
    const stagedPlanItem = (
      value: ReturnType<typeof chunk>
    ): MaterializationPlanWorkItem | null => {
      if (value.overrides.objectUpserts[0])
        return { kind: "object-override-upsert", value: value.overrides.objectUpserts[0] }
      if (value.overrides.objectDeletes[0])
        return { kind: "object-override-delete", value: value.overrides.objectDeletes[0] }
      if (value.overrides.linkUpserts[0])
        return { kind: "link-override-upsert", value: value.overrides.linkUpserts[0] }
      if (value.overrides.linkDeletes[0])
        return { kind: "link-override-delete", value: value.overrides.linkDeletes[0] }
      if (value.effective.objectUpserts[0])
        return { kind: "object-upsert", value: value.effective.objectUpserts[0] }
      if (value.effective.objectDeletes[0])
        return { kind: "object-delete", value: value.effective.objectDeletes[0] }
      if (value.effective.linkUpserts[0])
        return { kind: "link-upsert", value: value.effective.linkUpserts[0] }
      if (value.effective.linkDeletes[0])
        return { kind: "link-delete", value: value.effective.linkDeletes[0] }
      if (value.timeseries.pointUpserts[0])
        return { kind: "point-upsert", value: value.timeseries.pointUpserts[0] }
      return null
    }
    const cases = [
      {
        name: "object upsert ref",
        mutate(value: ReturnType<typeof chunk>, commitId: string) {
          value.effective.objectUpserts.push({
            row: {
              ref: objectA,
              properties: { name: "a" },
              version: 1,
              createdAt: committedAt,
              updatedAt: committedAt,
              lastCommitId: commitId,
            },
            expected: { ref: objectB, exists: false },
          })
        },
        message: "references differ",
      },
      {
        name: "object delete ref",
        mutate(value: ReturnType<typeof chunk>) {
          value.effective.objectDeletes.push({
            ref: objectA,
            expected: { ref: objectB, exists: true, version: 1, lastCommitId: "old" },
          })
        },
        message: "references differ",
      },
      {
        name: "link upsert ref",
        mutate(value: ReturnType<typeof chunk>, commitId: string) {
          value.effective.linkUpserts.push({
            row: {
              ref: linkA,
              createdAt: committedAt,
              updatedAt: committedAt,
              lastCommitId: commitId,
            },
            expected: { ref: linkB, exists: false },
          })
        },
        message: "references differ",
      },
      {
        name: "link delete ref",
        mutate(value: ReturnType<typeof chunk>) {
          value.effective.linkDeletes.push({
            ref: linkA,
            expected: { ref: linkB, exists: true, lastCommitId: "old" },
          })
        },
        message: "references differ",
      },
      {
        name: "point identity",
        mutate(value: ReturnType<typeof chunk>, commitId: string) {
          value.timeseries.pointUpserts.push({
            point: {
              series: { object: objectA, propertyId: "temperature" },
              value: 1,
              at: committedAt,
              lastCommitId: commitId,
            },
            expected: {
              series: { object: objectB, propertyId: "temperature" },
              at: committedAt,
              lastCommitId: null,
            },
          })
        },
        message: "expected identity",
      },
      {
        name: "override provenance",
        mutate(value: ReturnType<typeof chunk>) {
          value.overrides.objectUpserts.push({
            ref: objectA,
            value: { kind: "create", properties: { name: "a" } },
            expectedLastCommitId: null,
            lastCommitId: "wrong",
            updatedAt: committedAt,
          })
        },
        message: "provenance",
      },
      {
        name: "object override CAS",
        mutate(value: ReturnType<typeof chunk>, commitId: string) {
          value.overrides.objectUpserts.push({
            ref: objectA,
            value: { kind: "create", properties: { name: "a" } },
            expectedLastCommitId: "stale",
            lastCommitId: commitId,
            updatedAt: committedAt,
          })
        },
        message: "Expected object override changed",
      },
      {
        name: "object override delete CAS",
        mutate(value: ReturnType<typeof chunk>) {
          value.overrides.objectDeletes.push({ ref: objectA, expectedLastCommitId: "stale" })
        },
        message: "Expected object override changed",
      },
      {
        name: "link override provenance",
        mutate(value: ReturnType<typeof chunk>) {
          value.overrides.linkUpserts.push({
            ref: linkA,
            value: { kind: "upsert" },
            expectedLastCommitId: null,
            lastCommitId: "wrong",
            updatedAt: committedAt,
          })
        },
        message: "provenance",
      },
      {
        name: "link override CAS",
        mutate(value: ReturnType<typeof chunk>, commitId: string) {
          value.overrides.linkUpserts.push({
            ref: linkA,
            value: { kind: "upsert" },
            expectedLastCommitId: "stale",
            lastCommitId: commitId,
            updatedAt: committedAt,
          })
        },
        message: "Expected link override changed",
      },
      {
        name: "link override delete CAS",
        mutate(value: ReturnType<typeof chunk>) {
          value.overrides.linkDeletes.push({ ref: linkA, expectedLastCommitId: "stale" })
        },
        message: "Expected link override changed",
      },
      {
        name: "effective object provenance",
        mutate(value: ReturnType<typeof chunk>, commitId: string) {
          value.effective.objectUpserts.push({
            row: {
              ref: objectA,
              properties: { name: "a" },
              version: 1,
              createdAt: committedAt,
              updatedAt: "2026-01-02T00:00:00.000Z",
              lastCommitId: commitId,
            },
            expected: { ref: objectA, exists: false },
          })
        },
        message: "provenance",
      },
      {
        name: "effective provenance",
        mutate(value: ReturnType<typeof chunk>, commitId: string) {
          value.effective.linkUpserts.push({
            row: {
              ref: linkA,
              createdAt: committedAt,
              updatedAt: "2026-01-02T00:00:00.000Z",
              lastCommitId: commitId,
            },
            expected: { ref: linkA, exists: false },
          })
        },
        message: "provenance",
      },
      {
        name: "point timestamp identity",
        mutate(value: ReturnType<typeof chunk>, commitId: string) {
          value.timeseries.pointUpserts.push({
            point: {
              series: { object: objectA, propertyId: "temperature" },
              value: 1,
              at: committedAt,
              lastCommitId: commitId,
            },
            expected: {
              series: { object: objectA, propertyId: "temperature" },
              at: "2026-01-01T00:00:01.000Z",
              lastCommitId: null,
            },
          })
        },
        message: "expected identity",
      },
      {
        name: "point provenance",
        mutate(value: ReturnType<typeof chunk>) {
          value.timeseries.pointUpserts.push({
            point: {
              series: { object: objectA, propertyId: "temperature" },
              value: 1,
              at: committedAt,
              lastCommitId: "wrong",
            },
            expected: {
              series: { object: objectA, propertyId: "temperature" },
              at: committedAt,
              lastCommitId: null,
            },
          })
        },
        message: "last commit id",
      },
      {
        name: "outbox correlation",
        mutate(value: ReturnType<typeof chunk>, commitId: string) {
          value.outbox.push({
            envelope: {
              id: createEventId("other-project", commitId, 0),
              schemaVersion: 1,
              projectId: "other-project",
              occurredAt: committedAt,
              origin: { kind: "runtime", requestId: commitId },
              commitId,
              commitOrdinal: 0,
              partitionKey: "Device:a",
              type: "object.created",
              topic: "objects",
              payload: {
                objectTypeId: "Device",
                primaryId: "a",
                properties: { name: "a" },
                propertyChanges: {},
              },
            },
            availableAt: committedAt,
            createdAt: committedAt,
          })
        },
        message: "Outbox event",
      },
    ]
    for (const testCase of cases) {
      const commitId = `exact-${testCase.name}`
      const plan = chunk()
      testCase.mutate(plan, commitId)
      const before = getInMemoryOntologyStorageTestingAdapter(storage.ontology).snapshot()
      await expect(
        storage.transaction(async (tx) => {
          if (!tx.ontology) throw new Error("missing ontology")
          const session = await tx.ontology.materializations.begin({
            commit: {
              projectId: "project",
              id: commitId,
              idempotencyKey: `runtime:${commitId}`,
              requestHash: commitId,
              origin: { kind: "runtime", requestId: commitId },
              ontologyRevision: "revision",
              intent: { kind: "edit", mode: "atomic", operationCount: 0 },
              committedAt,
            },
            expected: {
              sources: [],
              objects: [],
              links: [],
              linkScopes: [],
              points: [],
            },
          })
          const stagedItem = stagedPlanItem(plan)
          if (stagedItem) {
            await tx.ontology.materializations.stageWork({
              session,
              records: [planWork(stagedItem, "61")],
            })
            for await (const _page of tx.ontology.materializations.streamWork({
              session,
              order: "apply",
              pageRows: 1,
            })) {
              // Make the exact provider plan eligible for application.
            }
          }
          await tx.ontology.materializations.applyChunk({ session, chunk: plan })
        })
      ).rejects.toThrow(testCase.message)
      expect(getInMemoryOntologyStorageTestingAdapter(storage.ontology).snapshot()).toEqual(before)
    }
  })

  test("rejects ordinal finalization mismatches with rollback", async () => {
    const storage = new InMemoryStorage()
    await storage.actionRuns.queue({
      id: "run",
      projectId: "project",
      actionId: "action",
      subject: { kind: "object", objectTypeId: "Device", primaryId: "one" },
      params: {},
      idempotencyKey: "action:project:run",
    })
    await storage.actionRuns.start({ id: "run", projectId: "project" })
    const committedAt = "2026-01-01T00:00:00.000Z"
    const header = (id: string, operationCount = 0): MaterializationPlanHeader => ({
      commit: {
        projectId: "project",
        id,
        idempotencyKey: `action:${id}:edits`,
        requestHash: id,
        origin: { kind: "action", actionId: "action", runId: "run" },
        ontologyRevision: "revision",
        intent: { kind: "edit", mode: "atomic", operationCount },
        committedAt,
      },
      expected: {
        sources: [],
        objects: [],
        links: [],
        linkScopes: [],
        points: [],
      },
    })
    const before = getInMemoryOntologyStorageTestingAdapter(storage.ontology).snapshot()
    await expect(
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        const session = await tx.ontology.materializations.begin(header("ordinal-gap"))
        await tx.ontology.materializations.stageWork({
          session,
          records: [
            {
              kind: "event",
              recordKey: "event:0:61",
              eventKindRank: 0,
              sortKey: "61",
              draft: {
                schemaVersion: 1,
                projectId: "project",
                occurredAt: committedAt,
                origin: { kind: "action", actionId: "action", runId: "run" },
                commitId: "ordinal-gap",
                partitionKey: "Device:one",
                type: "object.created",
                topic: "objects",
                payload: {
                  objectTypeId: "Device",
                  primaryId: "one",
                  properties: { name: "one" },
                  propertyChanges: {},
                },
              },
            },
          ],
        })
        for await (const _page of tx.ontology.materializations.streamWork({
          session,
          order: "event",
          pageRows: 1,
        })) {
          // The outbox write below deliberately skips canonical ordinal zero.
        }
        await tx.ontology.materializations.applyChunk({
          session,
          chunk: {
            overrides: {
              objectUpserts: [],
              objectDeletes: [],
              linkUpserts: [],
              linkDeletes: [],
            },
            effective: {
              objectUpserts: [],
              objectDeletes: [],
              linkUpserts: [],
              linkDeletes: [],
            },
            timeseries: { pointUpserts: [] },
            outbox: [
              {
                envelope: {
                  id: createEventId("project", "ordinal-gap", 1),
                  schemaVersion: 1,
                  projectId: "project",
                  occurredAt: committedAt,
                  origin: { kind: "action", actionId: "action", runId: "run" },
                  commitId: "ordinal-gap",
                  commitOrdinal: 1,
                  partitionKey: "Device:one",
                  type: "object.created",
                  topic: "objects",
                  payload: {
                    objectTypeId: "Device",
                    primaryId: "one",
                    properties: { name: "one" },
                    propertyChanges: {},
                  },
                },
                availableAt: committedAt,
                createdAt: committedAt,
              },
            ],
          },
        })
        await tx.ontology.materializations.finalize({
          session,
          finalization: {
            sourceActivations: [],
            result: {
              kind: "edit",
              commitId: "ordinal-gap",
              created: true,
              eventCount: 1,
              outcomes: [],
              changes: { objects: [], links: [] },
            },
          },
        })
      })
    ).rejects.toThrow("exact streamed order")
    expect(getInMemoryOntologyStorageTestingAdapter(storage.ontology).snapshot()).toEqual(before)
  })

  test("refuses activation until replacement state is fully streamed and classified", async () => {
    const storage = new InMemoryStorage()
    const source = { projectionId: "devices" }
    const datasetVersion = {
      datasetId: "devices",
      versionId: "sealed-candidate",
      createdAt: "2026-01-01T00:00:00.000Z",
    }
    const identity = {
      projectionId: "devices",
      projectionKind: "object" as const,
      protocol: "replacement" as const,
      datasetVersion,
      ontologyRevision: "ontology-revision",
      projectionRevision: "projection-revision",
      ownershipHash: "ownership-hash",
    }
    const run = await storage.projectionRuns.startOrReclaimMaterialization({
      id: "sealed-run",
      projectId: "project",
      identity,
      objectTypeId: "Device",
    })
    if (!run.executionToken) throw new Error("Expected a projection execution token")
    const execution = { projectionRunId: run.id, executionToken: run.executionToken }
    await storage.ontology.sources.beginMaterialization({
      projectId: "project",
      source,
      materializationId: "sealed-candidate",
      execution,
      projectionKind: "object",
      protocol: "replacement",
      datasetVersion,
      ontologyRevision: identity.ontologyRevision,
      projectionRevision: identity.projectionRevision,
      ownershipHash: identity.ownershipHash,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    await storage.ontology.sources.stageRows({
      projectId: "project",
      source,
      materializationId: "sealed-candidate",
      execution,
      rows: [
        {
          root: { kind: "object", ref: { objectTypeId: "Device", primaryId: "one" } },
          assertion: {
            kind: "object",
            ref: { objectTypeId: "Device", primaryId: "one" },
            properties: { name: "one" },
          },
          stagingOrdinal: 0,
        },
      ],
    })
    await storage.ontology.sources.markReady({
      projectId: "project",
      source,
      materializationId: "sealed-candidate",
      execution,
      rootCount: 1,
      assertionCount: 1,
      readyAt: "2026-01-01T00:01:00.000Z",
    })
    const counts = zeroReplacementCounts()
    const header: MaterializationPlanHeader = {
      commit: {
        projectId: "project",
        id: "sealed-commit",
        idempotencyKey: "projection:sealed",
        requestHash: "sealed",
        origin: {
          kind: "projection",
          projectionId: "devices",
          projectionRunId: run.id,
          datasetId: datasetVersion.datasetId,
          datasetVersionId: datasetVersion.versionId,
        },
        ontologyRevision: identity.ontologyRevision,
        projectionRevision: identity.projectionRevision,
        ownershipHash: identity.ownershipHash,
        intent: { kind: "projection", source, datasetVersion },
        committedAt: "2026-01-02T00:00:00.000Z",
      },
      expected: {
        sources: [{ source, activeMaterializationId: null, lastCommitId: null }],
        objects: [],
        links: [],
        linkScopes: [],
        points: [],
      },
    }
    const finalization: MaterializationPlanFinalization = {
      sourceActivations: [
        {
          source,
          materializationId: "sealed-candidate",
          execution,
          projectionKind: "object",
          protocol: "replacement",
          datasetVersion,
          ontologyRevision: identity.ontologyRevision,
          projectionRevision: identity.projectionRevision,
          ownershipHash: identity.ownershipHash,
          expected: { source, activeMaterializationId: null, lastCommitId: null },
          lastCommitId: "sealed-commit",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      result: {
        kind: "projection",
        commitId: "sealed-commit",
        created: true,
        eventCount: 0,
        counts,
      },
    }
    const finalizeWithoutSemanticWork = (streamReplacement: boolean) =>
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        const session = await tx.ontology.materializations.begin(header)
        if (streamReplacement) {
          for (const entityKind of ["object", "link"] as const) {
            for await (const _page of tx.ontology.materializations.streamSourceReplacementState({
              session,
              source,
              candidateMaterializationId: "sealed-candidate",
              entityKind,
              pageRows: 1,
            })) {
              // Deliberately omit classification work to exercise provider sealing.
            }
          }
        }
        return tx.ontology.materializations.finalize({ session, finalization })
      })

    await expect(finalizeWithoutSemanticWork(false)).rejects.toThrow(
      "does not match the replacement candidate opened"
    )
    await expect(finalizeWithoutSemanticWork(true)).rejects.toThrow("classification coverage")
    expect(await storage.ontology.sources.getActive({ projectId: "project", source })).toBeNull()
  })

  test("rejects projection header, activation, and result correlation mismatches", async () => {
    const cases: readonly {
      readonly name: string
      readonly mutate: (
        header: DeepMutable<MaterializationPlanHeader>,
        finalization: DeepMutable<MaterializationPlanFinalization>
      ) => void
      readonly message: string
    }[] = [
      {
        name: "intent source",
        mutate(header) {
          if (header.commit.origin.kind !== "projection") throw new Error("bad fixture origin")
          header.commit.origin.projectionId = "other"
        },
        message: "metadata does not correlate with its intent",
      },
      {
        name: "empty run origin",
        mutate(header) {
          if (header.commit.origin.kind !== "projection") throw new Error("bad fixture origin")
          header.commit.origin.projectionRunId = ""
        },
        message: "Projection run id must be nonblank",
      },
      {
        name: "activation source",
        mutate(_header, finalization) {
          finalization.sourceActivations[0].source.projectionId = "other"
        },
        message: "Source activation does not correlate",
      },
      {
        name: "activation dataset",
        mutate(_header, finalization) {
          finalization.sourceActivations[0].datasetVersion.versionId = "other"
        },
        message: "Source activation does not correlate",
      },
      {
        name: "activation projection revision",
        mutate(_header, finalization) {
          finalization.sourceActivations[0].projectionRevision = "other"
        },
        message: "Source activation does not correlate",
      },
      {
        name: "activation ownership",
        mutate(_header, finalization) {
          finalization.sourceActivations[0].ownershipHash = "other"
        },
        message: "Source activation does not correlate",
      },
      {
        name: "activation ontology revision",
        mutate(_header, finalization) {
          finalization.sourceActivations[0].ontologyRevision = "other"
        },
        message: "Source activation does not correlate",
      },
      {
        name: "activation commit",
        mutate(_header, finalization) {
          finalization.sourceActivations[0].lastCommitId = "other"
        },
        message: "Source activation does not correlate",
      },
      {
        name: "result commit",
        mutate(_header, finalization) {
          finalization.result.commitId = "other"
        },
        message: "result does not correlate",
      },
    ]

    for (const testCase of cases) {
      const storage = new InMemoryStorage()
      const source = { projectionId: "devices" }
      const datasetVersion = {
        datasetId: "devices",
        versionId: "v1",
        createdAt: "2026-01-01T00:00:00.000Z",
      }
      const run = await storage.projectionRuns.startOrReclaimMaterialization({
        id: "run",
        projectId: "project",
        identity: {
          projectionId: "devices",
          projectionKind: "object",
          protocol: "replacement",
          datasetVersion,
          ontologyRevision: "ontology-revision",
          projectionRevision: "projection-revision",
          ownershipHash: "ownership-hash",
        },
        objectTypeId: "Device",
      })
      if (!run.executionToken) throw new Error("Expected a projection execution token")
      const execution = { projectionRunId: run.id, executionToken: run.executionToken }
      await storage.ontology.sources.beginMaterialization({
        projectId: "project",
        source,
        materializationId: "candidate",
        execution,
        projectionKind: "object",
        protocol: "replacement",
        datasetVersion,
        projectionRevision: "projection-revision",
        ownershipHash: "ownership-hash",
        ontologyRevision: "ontology-revision",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      await storage.ontology.sources.stageRows({
        projectId: "project",
        source,
        materializationId: "candidate",
        execution,
        rows: [
          {
            root: { kind: "object", ref: { objectTypeId: "Device", primaryId: "one" } },
            assertion: {
              kind: "object",
              ref: { objectTypeId: "Device", primaryId: "one" },
              properties: { name: "one" },
            },
            stagingOrdinal: 0,
          },
        ],
      })
      await storage.ontology.sources.markReady({
        projectId: "project",
        source,
        materializationId: "candidate",
        execution,
        rootCount: 1,
        assertionCount: 1,
        readyAt: "2026-01-01T00:01:00.000Z",
      })
      const header: DeepMutable<MaterializationPlanHeader> = {
        commit: {
          projectId: "project",
          id: `correlation-${testCase.name}`,
          idempotencyKey: `projection:correlation:${testCase.name}`,
          requestHash: testCase.name,
          origin: {
            kind: "projection",
            projectionId: "devices",
            projectionRunId: "run",
            datasetId: "devices",
            datasetVersionId: "v1",
          },
          ontologyRevision: "ontology-revision",
          projectionRevision: "projection-revision",
          ownershipHash: "ownership-hash",
          intent: { kind: "projection", source, datasetVersion },
          committedAt: "2026-01-02T00:00:00.000Z",
        },
        expected: {
          sources: [{ source, activeMaterializationId: null, lastCommitId: null }],
          objects: [],
          links: [],
          linkScopes: [],
          points: [],
        },
      }
      const emptyCounts = {
        objectsCreated: 0,
        objectsUpdated: 0,
        objectsDeleted: 0,
        objectsUnchanged: 0,
        linksCreated: 0,
        linksUpdated: 0,
        linksDeleted: 0,
        linksUnchanged: 0,
      }
      const finalization = structuredClone({
        sourceActivations: [
          {
            source,
            materializationId: "candidate",
            execution: { ...execution },
            projectionKind: "object",
            protocol: "replacement",
            datasetVersion,
            projectionRevision: "projection-revision",
            ownershipHash: "ownership-hash",
            ontologyRevision: "ontology-revision",
            expected: { source, activeMaterializationId: null, lastCommitId: null },
            lastCommitId: header.commit.id,
            updatedAt: header.commit.committedAt,
          },
        ],
        result: {
          kind: "projection",
          commitId: header.commit.id,
          created: true,
          eventCount: 0,
          counts: emptyCounts,
        },
      }) as DeepMutable<MaterializationPlanFinalization>
      testCase.mutate(header, finalization)
      const before = getInMemoryOntologyStorageTestingAdapter(storage.ontology).snapshot()
      await expect(
        storage.transaction(async (tx) => {
          if (!tx.ontology) throw new Error("missing ontology")
          const session = await tx.ontology.materializations.begin(header)
          await tx.ontology.materializations.finalize({ session, finalization })
        })
      ).rejects.toThrow(testCase.message)
      expect(getInMemoryOntologyStorageTestingAdapter(storage.ontology).snapshot()).toEqual(before)
    }
  })

  test("keeps commit time and event identities stable across serialization retry", async () => {
    const storage = new InMemoryStorage()
    let failures = 0
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      beforeWrite(boundary) {
        if (boundary === "finalize" && failures++ === 0) {
          throw new StorageTransactionError("retry", { code: "serialization_failure" })
        }
      },
    })
    let clockCalls = 0
    const { materializer } = createMaterializerFixture({
      storage,
      dependencies: {
        clock: () => {
          clockCalls += 1
          return new Date(`2026-01-0${clockCalls}T00:00:00Z`)
        },
      },
    })
    const result = await materializer.edits.commit(
      atomic("serialization-stable", [
        {
          id: "one",
          kind: "object.create",
          ref: { objectTypeId: "Device", primaryId: "one" },
          properties: { name: "one" },
        },
      ])
    )
    const [event] = await storage.ontology.outbox.claim({
      projectId: "project",
      now: "2027-01-01T00:00:00Z",
      limit: 10,
      leaseId: "stable-lease",
      leaseExpiresAt: "2027-01-01T01:00:00Z",
    })
    expect(clockCalls).toBe(1)
    expect(failures).toBe(2)
    expect(event.envelope).toMatchObject({
      id: createEventId("project", result.commitId, 0),
      commitId: result.commitId,
      occurredAt: "2026-01-01T00:00:00.000Z",
      commitOrdinal: 0,
    })
  })
})

async function expectLogicalOriginDuplicateRejected(
  storage: InMemoryStorage,
  commit: OntologyCommitRecord | null
): Promise<void> {
  if (!commit) throw new Error("Expected an authoritative ontology commit")
  const { result: _result, ...write } = commit
  const duplicate = {
    ...write,
    id: `${commit.id}-duplicate`,
    idempotencyKey: `${commit.idempotencyKey}:duplicate`,
    requestHash: `${commit.requestHash}:duplicate`,
    committedAt: new Date(Date.parse(commit.committedAt) + 1).toISOString(),
  } as OntologyCommitWrite
  await expect(
    storage.transaction(async (tx) => {
      if (!tx.ontology) throw new Error("missing ontology")
      await tx.ontology.materializations.begin({
        commit: duplicate,
        expected: { sources: [], objects: [], links: [], linkScopes: [], points: [] },
      })
    })
  ).rejects.toMatchObject({ kind: "run-correlation" })
}

type DeepMutable<T> = T extends readonly (infer TValue)[]
  ? DeepMutable<TValue>[]
  : T extends object
    ? { -readonly [TKey in keyof T]: DeepMutable<T[TKey]> }
    : T

async function claimReplacementExecution(
  storage: InMemoryStorage,
  projections: ProjectionRegistry,
  input: {
    readonly projectId: string
    readonly runId: string
    readonly datasetVersion: {
      readonly datasetId: string
      readonly versionId: string
      readonly createdAt: string
    }
  }
) {
  const resolved = projections.resolveSource("devices")
  if (resolved.definition._tag !== "ObjectProjectionDefinition") {
    throw new Error("Expected the devices object projection")
  }
  const run = await storage.projectionRuns.startOrReclaimMaterialization({
    id: input.runId,
    projectId: input.projectId,
    identity: replacementIdentity(projections, input.datasetVersion),
    objectTypeId: resolved.definition.objectTypeId,
  })
  if (!run.executionToken) throw new Error("Projection run claim returned no execution token")
  return { projectionRunId: run.id, executionToken: run.executionToken }
}

function replacementIdentity(
  projections: ProjectionRegistry,
  datasetVersion: {
    readonly datasetId: string
    readonly versionId: string
    readonly createdAt: string
  }
) {
  const resolved = projections.resolveSource("devices")
  return {
    projectionId: resolved.projectionId,
    projectionKind: "object" as const,
    protocol: "replacement" as const,
    datasetVersion: {
      ...datasetVersion,
      createdAt: new Date(datasetVersion.createdAt).toISOString(),
    },
    ontologyRevision: projections.ontologyRevision,
    projectionRevision: resolved.projectionRevision,
    ownershipHash: resolved.ownershipHash,
  }
}

function zeroReplacementCounts() {
  return {
    objectsCreated: 0,
    objectsUpdated: 0,
    objectsDeleted: 0,
    objectsUnchanged: 0,
    linksCreated: 0,
    linksUpdated: 0,
    linksDeleted: 0,
    linksUnchanged: 0,
  }
}
