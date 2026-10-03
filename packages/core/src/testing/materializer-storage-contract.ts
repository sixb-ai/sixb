import { expect, test } from "bun:test"
import {
  col,
  type DatasetDefinition,
  defineDataset,
  defineObjectType,
  defineProjection,
  link,
  OntologyRegistry,
  prop,
  type Storage,
} from ".."
import type { TrustedPrimitiveRef } from "../execution"
import { restoreTrustedPrimitiveExecutionScope } from "../execution/durable"
import { createTestingScope } from "../execution/scopes"
import type {
  ExpectedLinkRevision,
  ExpectedObjectRevision,
  OntologyMaterializer,
} from "../materializer"
import {
  createLinkScopeFingerprint,
  createOntologyMaterializer,
  type OntologyEditOperation,
  ProjectionRegistry,
  type ProjectionSourceBase,
  type ProjectionSourceDeletion,
  type ProjectionSourceEntry,
} from "../materializer"
import type {
  ActionRunStorage,
  OntologyReplacementPlanStorage,
  PlannedReplacementIdentity,
  ProjectionExecution,
  ProjectionRunStorage,
} from "../storage"
import { createTestActionExecution, queueTestActionRun } from "./action-execution"
import { createTestProjectionExecution, startTestProjectionRun } from "./projection-execution"

export interface MaterializerStorageContractProvider<TStorage extends Storage> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
  /** Write transactions run side by side instead of one after another. */
  readonly concurrentTransactions?: boolean
  /**
   * Moves the transaction ids that commits and plans recorded far ahead of the store's own, as a
   * logical restore from a cluster further along leaves them.
   */
  readonly restoreFromClusterAhead?: (storage: TStorage) => Promise<void>
}

type ContractStorage = Storage & {
  readonly actionRuns: ActionRunStorage
  readonly projectionRuns: ProjectionRunStorage
}

const Device = defineObjectType({
  id: "StorageContractDevice",
  name: "Device",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("name", "string", { required: true }),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
  links: [link.self("parent", { cardinality: "one" }), link.self("peers", { cardinality: "many" })],
})

const devices = defineDataset("storage_contract_devices", {
  schema: [
    col("id", "string"),
    col("name", "string"),
    col("parent_id", "string", { nullable: true }),
  ],
})
const readings = defineDataset("storage_contract_readings", {
  schema: [col("device_id", "string"), col("at", "timestamp"), col("value", "float64")],
})
const devicePeers = defineDataset("storage_contract_device_peers", {
  schema: [col("source_id", "string"), col("target_id", "string")],
})
const ConflictDevice = defineObjectType({
  id: "StorageContractConflictDevice",
  name: "Conflict device",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("name", "string", { required: true }),
    prop("state", "string", { required: true }),
  ],
})
const conflictDevices = defineDataset("storage_contract_conflict_devices", {
  schema: [
    col("id", "string"),
    col("name", "string"),
    col("state", "string"),
    col("updated_at", "timestamp"),
  ],
})
const deviceProjection = defineProjection("storage_contract_devices", Device)
  .fromDataset(devices)
  .properties({ id: "id", name: "name" })
  .withLinks({
    parent: {
      link: Device.l.parent,
      sourceField: "parent_id",
      target: Device,
    },
  })
const temperatureProjection = defineProjection(
  "storage_contract_temperatures",
  Device.p.temperature
)
  .fromDataset(readings)
  .points({ objectId: "device_id", at: "at", value: "value" })
const devicePeersProjection = defineProjection("storage_contract_device_peers", Device.l.peers)
  .fromDataset(devicePeers)
  .sourceField("source_id")
  .targetField("target_id")
const conflictDeviceProjection = defineProjection(
  "storage_contract_conflict_devices",
  ConflictDevice
)
  .fromDataset(conflictDevices)
  .properties({ id: "id", name: "name", state: "state" })
  .resolveConflicts({ strategy: "mostRecent", sourceTimestamp: "updated_at" })

const ontology = new OntologyRegistry({ sources: [Device, ConflictDevice] })
const projections = new ProjectionRegistry({
  projections: [
    deviceProjection,
    temperatureProjection,
    devicePeersProjection,
    conflictDeviceProjection,
  ],
  ontology,
  datasetsById: new Map<string, DatasetDefinition>([
    [devices.id, devices],
    [readings.id, readings],
    [devicePeers.id, devicePeers],
    [conflictDevices.id, conflictDevices],
  ]),
})

export function runMaterializerStorageContractSuite<TStorage extends Storage>(
  name: string,
  provider: MaterializerStorageContractProvider<TStorage>
): void {
  // Regression: replacing previousSourceRows with only the latest manifest loses "a" at v3.
  // Removing root retirement checks from cleanup deletes "a" when v1 becomes terminal.
  test(`${name} retains current roots across deltas, cleanup, overrides and full replacement`, async () => {
    const createdStorage = await provider.createStorage()
    const storage = requireContractStorage(createdStorage)
    let ordinal = 0
    const projectId = "materializer-storage-contract"
    const source = { projectionId: devices.id }
    const materializer = createOntologyMaterializer({
      projectId,
      ontology,
      projections,
      storage,
      dependencies: { batching: { sourceStageRows: 1, statePageRows: 1, planChunkRows: 1 } },
    })
    const active = async (): Promise<ProjectionSourceBase> => {
      const current = await materializer.projections.getActive(source)
      if (!current?.lastCommitId) throw new Error("Missing source head")
      return { materializationId: current.materializationId, lastCommitId: current.lastCommitId }
    }
    const replace = async (
      values: readonly (ProjectionSourceEntry | ProjectionSourceDeletion)[],
      base?: ProjectionSourceBase,
      interleave?: { readonly version: number; readonly beforeSeal?: () => Promise<void> }
    ) => {
      const version = interleave?.version ?? ++ordinal
      const datasetVersion = {
        datasetId: devices.id,
        versionId: `delta-v${version}`,
        createdAt: `2026-01-${String(version).padStart(2, "0")}T00:00:00.000Z`,
      }
      const execution = await claim(storage, {
        runId: `delta-run-${version}`,
        projectionId: devices.id,
        protocol: "replacement",
        datasetVersion,
      })
      const bound = await projectionMaterializer(
        materializer,
        storage,
        devices.id,
        execution.projectionRunId
      )
      return bound.projections.replace({
        source,
        datasetVersion,
        execution,
        entries: (async function* () {
          yield* entries(values)
          await interleave?.beforeSeal?.()
        })(),
        ...(base ? { base } : {}),
      })
    }
    const ref = (primaryId: string) => ({ objectTypeId: Device.id, primaryId })
    const object = (id: string) => storage.objects.getByPrimaryId({ projectId, ...ref(id) })
    const remove = (id: string): ProjectionSourceDeletion => ({
      root: { kind: "object", ref: ref(id) },
      deleted: true,
    })
    try {
      await replace([sourceEntry("a", "A"), sourceEntry("b", "B", "a"), sourceEntry("c", "C")])
      const stale = await active()
      const initialA = await object("a")
      const initialB = await object("b")
      const transact = storage.transaction.bind(storage)
      // Fail after finalize has moved the source pointers, written the commit and its outbox.
      // Removing the enclosing transaction rollback must fail these head/value assertions.
      storage.transaction = (run, options) =>
        transact(async (tx) => {
          const materializations = new Proxy(tx.ontology.materializations, {
            get(target, key) {
              if (key !== "finalize") return Reflect.get(target, key)
              return async (input: Parameters<typeof target.finalize>[0]) => {
                await target.finalize(input)
                throw new Error("injected after source activation")
              }
            },
          })
          const ontology = new Proxy(tx.ontology, {
            get(target, key) {
              return key === "materializations" ? materializations : Reflect.get(target, key)
            },
          })
          return run(
            new Proxy(tx, {
              get(target, key) {
                return key === "ontology" ? ontology : Reflect.get(target, key)
              },
            })
          )
        }, options)
      try {
        await expect(replace([remove("a"), sourceEntry("b", "Failed B")], stale)).rejects.toThrow(
          "injected after source activation"
        )
      } finally {
        storage.transaction = transact
      }
      expect(await active()).toEqual(stale)
      expect(await object("a")).toEqual(initialA)
      expect(await object("b")).toEqual(initialB)
      await replace([sourceEntry("b", "B2", "c")], await active())
      await replace([sourceEntry("c", "C2")], await active())
      expect(await object("a")).toEqual(initialA)
      expect(await object("b")).toMatchObject({ properties: { name: "B2" } })
      for (let pass = 0; pass < 20; pass++) {
        const result = await storage.ontology.sources.cleanupTerminal({
          projectId,
          terminalBefore: "2100-01-01T00:00:00.000Z",
          limit: 2,
        })
        if (result.rowsDeleted + result.materializationsDeleted === 0) break
      }
      const scoped = materializer.withScope(runtimeScope())
      const edit = (operations: readonly OntologyEditOperation[]) =>
        scoped.edits.commit({
          mode: "atomic",
          source: { kind: "runtime", requestId: `delta-edit-${++ordinal}` },
          operations,
          expectedObjects: [],
          expectedLinks: [],
          expectedLinkScopes: [],
        })
      await edit([
        { id: "edit-a", kind: "object.upsert", ref: ref("a"), properties: { name: "Edited A" } },
      ])
      await edit([
        { id: "reset-a", kind: "object.patch", ref: ref("a"), set: {}, unset: [], reset: ["name"] },
      ])
      expect(await object("a")).toMatchObject({ properties: { name: "A" } })
      await replace([], await active())
      expect(await object("a")).toMatchObject({ properties: { name: "A" } })
      await expect(replace([remove("a")], stale)).rejects.toMatchObject({
        kind: "source-materialization",
      })
      expect(await object("a")).not.toBeNull()
      await replace([remove("a")], await active())
      expect(await object("a")).toBeNull()
      expect(await object("b")).toMatchObject({ properties: { name: "B2" } })
      await replace([sourceEntry("b", "B3")])
      expect(await object("b")).toMatchObject({ properties: { name: "B3" } })
      expect(await object("c")).toBeNull()
      await replace([], await active())
      expect(await object("b")).toMatchObject({ properties: { name: "B3" } })
      await replace([])
      expect(await object("b")).toBeNull()

      // A different run commits after base validation but before this candidate is sealed.
      // Only checking the base before reading the delta would allow a stale publication here.
      const base = await active()
      const earlier = ++ordinal
      const later = ++ordinal
      await expect(
        replace([sourceEntry("a", "Stale delta")], base, {
          version: later,
          beforeSeal: async () => {
            await replace([sourceEntry("a", "Concurrent value")], base, { version: earlier })
          },
        })
      ).rejects.toMatchObject({ kind: "source-materialization" })
      expect(await object("a")).toMatchObject({ properties: { name: "Concurrent value" } })
      await replace([sourceEntry("a", "Fresh delta")], await active())
      expect(await object("a")).toMatchObject({ properties: { name: "Fresh delta" } })
    } finally {
      await provider.cleanup?.(createdStorage)
    }
  })

  test(`${name} persists replacement, Action, and telemetry commits atomically`, async () => {
    const createdStorage = await provider.createStorage()
    const storage = requireContractStorage(createdStorage)
    let materializationOrdinal = 0
    const materializer = createOntologyMaterializer({
      projectId: "materializer-storage-contract",
      ontology,
      projections,
      storage,
      dependencies: {
        batching: { sourceStageRows: 1, statePageRows: 1, planChunkRows: 1 },
        clock: () => new Date("2026-02-01T12:00:00.000Z"),
        materializationId: () => `storage-contract-candidate-${++materializationOrdinal}`,
      },
    })
    try {
      const firstVersion = {
        datasetId: devices.id,
        versionId: "v1",
        createdAt: "2026-01-01T00:00:00.000Z",
      }
      const firstExecution = await claim(storage, {
        runId: "replacement-v1",
        projectionId: deviceProjection.id,
        protocol: "replacement",
        datasetVersion: firstVersion,
      })
      const firstMaterializer = await projectionMaterializer(
        materializer,
        storage,
        deviceProjection.id,
        "replacement-v1"
      )
      const first = await firstMaterializer.projections.replace({
        source: { projectionId: deviceProjection.id },
        datasetVersion: firstVersion,
        execution: firstExecution,
        entries: entries([sourceEntry("one", "One", "two"), sourceEntry("two", "Two")]),
      })
      expect(first.counts).toMatchObject({ objectsCreated: 2, linksCreated: 1 })
      expect(
        await storage.objects.getByPrimaryId({
          projectId: "materializer-storage-contract",
          objectTypeId: Device.id,
          primaryId: "one",
        })
      ).toMatchObject({ properties: { id: "one", name: "One" }, lastCommitId: first.commitId })

      const secondVersion = {
        datasetId: devices.id,
        versionId: "v2",
        createdAt: "2026-01-02T00:00:00.000Z",
      }
      const secondExecution = await claim(storage, {
        runId: "replacement-v2",
        projectionId: deviceProjection.id,
        protocol: "replacement",
        datasetVersion: secondVersion,
      })
      const secondMaterializer = await projectionMaterializer(
        materializer,
        storage,
        deviceProjection.id,
        "replacement-v2"
      )
      const second = await secondMaterializer.projections.replace({
        source: { projectionId: deviceProjection.id },
        datasetVersion: secondVersion,
        execution: secondExecution,
        entries: entries([sourceEntry("one", "One updated")]),
      })
      expect(second.counts).toMatchObject({
        objectsUpdated: 1,
        objectsDeleted: 1,
        linksDeleted: 1,
      })
      expect(
        await storage.objects.getByPrimaryId({
          projectId: "materializer-storage-contract",
          objectTypeId: Device.id,
          primaryId: "two",
        })
      ).toBeNull()

      await createTestActionExecution(storage.executions, {
        projectId: "materializer-storage-contract",
        actionId: "renameDevice",
        runId: "missing-action-run",
      })
      const missingActionMaterializer = await primitiveMaterializer(materializer, storage, {
        kind: "action",
        id: "renameDevice",
        runId: "missing-action-run",
      })
      await expect(
        missingActionMaterializer.edits.commit({
          mode: "atomic",
          source: { kind: "action", actionId: "renameDevice", runId: "missing-action-run" },
          operations: [
            {
              id: "missing-run-rename",
              kind: "object.patch",
              ref: { objectTypeId: Device.id, primaryId: "one" },
              set: { name: "Must not persist" },
              unset: [],
              reset: [],
            },
          ],
          expectedObjects: [],
          expectedLinks: [],
          expectedLinkScopes: [],
        })
      ).rejects.toThrow("missing-action-run")

      await queueTestActionRun(storage, {
        id: "action-run",
        projectId: "materializer-storage-contract",
        actionId: "renameDevice",
        subject: { kind: "object", objectTypeId: Device.id, primaryId: "one" },
        params: {},
        idempotencyKey: "action-run",
      })
      await storage.actionRuns.start({
        id: "action-run",
        projectId: "materializer-storage-contract",
      })
      const actionMaterializer = await primitiveMaterializer(materializer, storage, {
        kind: "action",
        id: "renameDevice",
        runId: "action-run",
      })
      const actionCommit = await actionMaterializer.edits.commit({
        mode: "atomic",
        source: { kind: "action", actionId: "renameDevice", runId: "action-run" },
        operations: [
          {
            id: "rename",
            kind: "object.patch",
            ref: { objectTypeId: Device.id, primaryId: "one" },
            set: { name: "Managed name" },
            unset: [],
            reset: [],
          },
        ],
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
      expect(
        await storage.ontology.commits.getByOrigin({
          projectId: "materializer-storage-contract",
          origin: { kind: "action", actionRunId: "action-run" },
        })
      ).toMatchObject({ id: actionCommit.commitId })

      const telemetryVersion = {
        datasetId: readings.id,
        versionId: "readings-v1",
        createdAt: "2026-01-03T00:00:00.000Z",
      }
      await createTestProjectionExecution(storage.executions, {
        projectId: "materializer-storage-contract",
        projectionId: temperatureProjection.id,
        runId: "missing-telemetry-run",
        datasetId: readings.id,
        datasetVersionId: "missing-readings-run",
      })
      const missingTelemetryMaterializer = await primitiveMaterializer(materializer, storage, {
        kind: "projection",
        id: temperatureProjection.id,
        runId: "missing-telemetry-run",
      })
      await expect(
        missingTelemetryMaterializer.telemetry.append({
          source: {
            kind: "projection",
            projection: { projectionId: temperatureProjection.id },
            datasetVersion: {
              datasetId: readings.id,
              versionId: "missing-readings-run",
              createdAt: "2026-01-02T12:00:00.000Z",
            },
            execution: {
              projectionRunId: "missing-telemetry-run",
              executionToken: "missing-execution-token",
            },
            batchOrdinal: 0,
            sourceRowCount: 1,
            sourceRowsSkipped: 0,
            inputExhausted: true,
          },
          points: [
            {
              series: {
                object: { objectTypeId: Device.id, primaryId: "one" },
                propertyId: "temperature",
              },
              value: 20,
              at: "2026-01-02T13:00:00.000Z",
            },
          ],
        })
      ).rejects.toThrow("missing-telemetry-run")

      const telemetryExecution = await claim(storage, {
        runId: "telemetry-v1",
        projectionId: temperatureProjection.id,
        protocol: "telemetry",
        datasetVersion: telemetryVersion,
        fixedBatchSize: 1,
      })
      const telemetryMaterializer = await projectionMaterializer(
        materializer,
        storage,
        temperatureProjection.id,
        "telemetry-v1"
      )
      const telemetry = await telemetryMaterializer.telemetry.append({
        source: {
          kind: "projection",
          projection: { projectionId: temperatureProjection.id },
          datasetVersion: telemetryVersion,
          execution: telemetryExecution,
          batchOrdinal: 0,
          sourceRowCount: 1,
          sourceRowsSkipped: 0,
          inputExhausted: true,
        },
        points: [
          {
            series: {
              object: { objectTypeId: Device.id, primaryId: "one" },
              propertyId: "temperature",
            },
            value: 21.5,
            at: "2026-01-03T01:00:00.000Z",
          },
        ],
      })
      expect(telemetry).toMatchObject({ pointsCreated: 1, latestObjectsChanged: 1 })
      expect(
        await storage.timeseries.getLatest({
          projectId: "materializer-storage-contract",
          objectTypeId: Device.id,
          objectId: "one",
          propertyId: "temperature",
        })
      ).toMatchObject({ value: 21.5, lastCommitId: telemetry.commitId })
    } finally {
      await provider.cleanup?.(createdStorage)
    }
  })

  test(`${name} persists per-property Action edit times`, async () => {
    const createdStorage = await provider.createStorage()
    const storage = requireContractStorage(createdStorage)
    let materializationOrdinal = 0
    let now = new Date("2026-02-01T00:00:10.000Z")
    const materializer = createOntologyMaterializer({
      projectId: "materializer-storage-contract",
      ontology,
      projections,
      storage,
      dependencies: {
        batching: { sourceStageRows: 1, statePageRows: 1, planChunkRows: 1 },
        clock: () => now,
        materializationId: () => `conflict-contract-candidate-${++materializationOrdinal}`,
      },
    })
    const runtimeMaterializer = materializer.withScope(runtimeScope())
    const ref = { objectTypeId: ConflictDevice.id, primaryId: "one" }
    const replace = async (
      versionId: string,
      sourceUpdatedAt: string,
      name: string,
      state: string
    ) => {
      const datasetVersion = {
        datasetId: conflictDevices.id,
        versionId,
        createdAt: sourceUpdatedAt,
      }
      const execution = await claim(storage, {
        runId: `conflict-${versionId}`,
        projectionId: conflictDeviceProjection.id,
        protocol: "replacement",
        datasetVersion,
      })
      const projectionMaterializerForRun = await projectionMaterializer(
        materializer,
        storage,
        conflictDeviceProjection.id,
        `conflict-${versionId}`
      )
      await projectionMaterializerForRun.projections.replace({
        source: { projectionId: conflictDeviceProjection.id },
        datasetVersion,
        execution,
        entries: entries([
          {
            root: { kind: "object", ref },
            assertions: [{ kind: "object", ref, properties: { name, state }, sourceUpdatedAt }],
          },
        ]),
      })
    }
    const edit = (requestId: string, propertyId: "name" | "state", value: string) =>
      runtimeMaterializer.edits.commit({
        mode: "atomic",
        source: { kind: "runtime", requestId },
        operations: [
          {
            id: requestId,
            kind: "object.patch",
            ref,
            set: { [propertyId]: value },
            unset: [],
            reset: [],
          },
        ],
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })

    try {
      await replace("v1", "2026-02-01T00:00:10.000Z", "Source A", "source-open")

      now = new Date("2026-02-01T00:00:11.000Z")
      await edit("conflict-name", "name", "Action B")
      now = new Date("2026-02-01T00:00:13.000Z")
      await edit("conflict-state", "state", "action-closed")

      await replace("v2", "2026-02-01T00:00:12.000Z", "Source C", "source-changed")
      expect(
        await storage.objects.getByPrimaryId({
          projectId: "materializer-storage-contract",
          objectTypeId: ConflictDevice.id,
          primaryId: "one",
        })
      ).toMatchObject({ properties: { id: "one", name: "Source C", state: "action-closed" } })
    } finally {
      await provider.cleanup?.(createdStorage)
    }
  })

  test(`${name} persists cardinality-one edit authority by scope`, async () => {
    const createdStorage = await provider.createStorage()
    const storage = requireContractStorage(createdStorage)
    let materializationOrdinal = 0
    const materializer = createOntologyMaterializer({
      projectId: "materializer-storage-contract",
      ontology,
      projections,
      storage,
      dependencies: {
        batching: { sourceStageRows: 1, statePageRows: 1, planChunkRows: 1 },
        clock: () => new Date("2026-02-01T12:00:00.000Z"),
        materializationId: () => `scope-contract-candidate-${++materializationOrdinal}`,
      },
    })
    const runtimeMaterializer = materializer.withScope(runtimeScope())
    const linkRef = (targetId: string) => ({
      source: { objectTypeId: Device.id, primaryId: "document" },
      linkId: "parent",
      target: { objectTypeId: Device.id, primaryId: targetId },
    })
    const replace = async (versionId: string, parentId: string) => {
      const datasetVersion = {
        datasetId: devices.id,
        versionId,
        createdAt: `2026-01-0${versionId.slice(1)}T00:00:00.000Z`,
      }
      const execution = await claim(storage, {
        runId: `scope-${versionId}`,
        projectionId: deviceProjection.id,
        protocol: "replacement",
        datasetVersion,
      })
      const projectionMaterializerForRun = await projectionMaterializer(
        materializer,
        storage,
        deviceProjection.id,
        `scope-${versionId}`
      )
      await projectionMaterializerForRun.projections.replace({
        source: { projectionId: deviceProjection.id },
        datasetVersion,
        execution,
        entries: entries([
          sourceEntry("document", "Document", parentId),
          sourceEntry("rockland", "Rockland"),
          sourceEntry("haverstraw", "Haverstraw"),
        ]),
      })
    }
    const edit = (requestId: string, operation: OntologyEditOperation) =>
      runtimeMaterializer.edits.commit({
        mode: "atomic",
        source: { kind: "runtime", requestId },
        operations: [operation],
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
    const targets = async () =>
      (
        await storage.objects.listLinks({
          projectId: "materializer-storage-contract",
          objectTypeId: Device.id,
          objectId: "document",
        })
      ).map((row) => row.targetId)

    try {
      await replace("v1", "rockland")
      await edit("scope-set", {
        id: "set",
        kind: "link.upsert",
        ref: linkRef("rockland"),
      })

      await replace("v2", "haverstraw")
      expect(await targets()).toEqual(["rockland"])

      await edit("scope-reset", {
        id: "reset",
        kind: "link.reset",
        ref: linkRef("rockland"),
      })
      expect(await targets()).toEqual(["haverstraw"])

      await edit("scope-clear", {
        id: "clear",
        kind: "link.delete",
        ref: linkRef("haverstraw"),
      })
      await replace("v3", "rockland")
      expect(await targets()).toEqual([])

      await edit("scope-clear-reset", {
        id: "reset",
        kind: "link.reset",
        ref: linkRef("haverstraw"),
      })
      expect(await targets()).toEqual(["rockland"])
    } finally {
      await provider.cleanup?.(createdStorage)
    }
  })

  test(`${name} rejects stale object and link expectations as expectation conflicts`, async () => {
    // Action runs report exactly this conflict kind as `action.read_conflict`. Throw a stale
    // expectation as another kind from any provider and this fails for that provider.
    const createdStorage = await provider.createStorage()
    const storage = requireContractStorage(createdStorage)
    const runtimeMaterializer = createOntologyMaterializer({
      projectId: "materializer-storage-contract",
      ontology,
      projections,
      storage,
      dependencies: { clock: () => new Date("2026-02-01T12:00:00.000Z") },
    }).withScope(runtimeScope())
    const device = { objectTypeId: Device.id, primaryId: "device" }
    const peerLink = {
      source: device,
      linkId: "peers",
      target: { objectTypeId: Device.id, primaryId: "peer" },
    }
    const commitExpecting = (
      requestId: string,
      expected: {
        readonly expectedObjects: readonly ExpectedObjectRevision[]
        readonly expectedLinks: readonly ExpectedLinkRevision[]
      }
    ) =>
      runtimeMaterializer.edits.commit({
        mode: "atomic",
        source: { kind: "runtime", requestId },
        operations: [
          {
            id: "rename",
            kind: "object.patch",
            ref: device,
            set: { name: requestId },
            unset: [],
            reset: [],
          },
        ],
        ...expected,
        expectedLinkScopes: [],
      })

    try {
      await runtimeMaterializer.edits.commit({
        mode: "atomic",
        source: { kind: "runtime", requestId: "expectation-setup" },
        operations: [
          { id: "device", kind: "object.create", ref: device, properties: { name: "device" } },
          {
            id: "peer",
            kind: "object.create",
            ref: peerLink.target,
            properties: { name: "peer" },
          },
          { id: "link", kind: "link.upsert", ref: peerLink },
        ],
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })

      await expect(
        commitExpecting("stale-object", {
          expectedObjects: [{ ref: device, exists: false }],
          expectedLinks: [],
        })
      ).rejects.toMatchObject({ kind: "expectation" })
      await expect(
        commitExpecting("stale-link", {
          expectedObjects: [],
          expectedLinks: [{ ref: peerLink, exists: false }],
        })
      ).rejects.toMatchObject({ kind: "expectation" })
    } finally {
      await provider.cleanup?.(createdStorage)
    }
  })

  test(`${name} fences projected cardinality-many link scopes by fingerprint`, async () => {
    const createdStorage = await provider.createStorage()
    const storage = requireContractStorage(createdStorage)
    let materializationOrdinal = 0
    const materializer = createOntologyMaterializer({
      projectId: "materializer-storage-contract",
      ontology,
      projections,
      storage,
      dependencies: {
        batching: { sourceStageRows: 1, statePageRows: 1, planChunkRows: 1 },
        clock: () => new Date("2026-02-01T12:00:00.000Z"),
        materializationId: () => `many-scope-contract-candidate-${++materializationOrdinal}`,
      },
    })
    const runtimeMaterializer = materializer.withScope(runtimeScope())
    const source = { objectTypeId: Device.id, primaryId: "source" }
    const peer = (primaryId: string) => ({ objectTypeId: Device.id, primaryId })
    const linkRef = (targetId: string) => ({
      source,
      linkId: "peers",
      target: peer(targetId),
    })

    try {
      await runtimeMaterializer.edits.commit({
        mode: "atomic",
        source: { kind: "runtime", requestId: "many-scope-endpoints" },
        operations: ["source", "peer-a", "peer-b", "peer-c"].map((primaryId) => ({
          id: `create-${primaryId}`,
          kind: "object.create" as const,
          ref: peer(primaryId),
          properties: { name: primaryId },
        })),
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })

      const datasetVersion = {
        datasetId: devicePeers.id,
        versionId: "many-links-v1",
        createdAt: "2026-02-01T00:00:00.000Z",
      }
      const execution = await claim(storage, {
        runId: "many-links-v1",
        projectionId: devicePeersProjection.id,
        protocol: "replacement",
        datasetVersion,
      })
      const projectedLinks = [linkRef("peer-a"), linkRef("peer-b")]
      await (
        await projectionMaterializer(
          materializer,
          storage,
          devicePeersProjection.id,
          "many-links-v1"
        )
      ).projections.replace({
        source: { projectionId: devicePeersProjection.id },
        datasetVersion,
        execution,
        entries: entries(
          projectedLinks.map((ref) => ({
            root: { kind: "link", ref },
            assertions: [{ kind: "link", ref }],
          }))
        ),
      })

      const observedLinks = await storage.objects.listLinks({
        projectId: "materializer-storage-contract",
        objectTypeId: Device.id,
        objectId: source.primaryId,
        linkId: "peers",
      })
      const fingerprint = createLinkScopeFingerprint(
        observedLinks.map((row) => {
          if (row.lastCommitId === undefined) {
            throw new Error("Projected contract link is missing materializer provenance.")
          }
          return {
            ref: linkRef(row.targetId),
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
            lastCommitId: row.lastCommitId,
          }
        })
      )
      const commitObservation = async (runId: string, name: string) => {
        await queueTestActionRun(storage, {
          id: runId,
          projectId: "materializer-storage-contract",
          actionId: "observePeers",
          subject: { kind: "object", objectTypeId: Device.id, primaryId: source.primaryId },
          params: {},
          idempotencyKey: runId,
        })
        await storage.actionRuns.start({ id: runId, projectId: "materializer-storage-contract" })
        const actionMaterializer = await primitiveMaterializer(materializer, storage, {
          kind: "action",
          id: "observePeers",
          runId,
        })
        return actionMaterializer.edits.commit({
          mode: "atomic",
          source: { kind: "action", actionId: "observePeers", runId },
          operations: [
            {
              id: `record-${runId}`,
              kind: "object.patch",
              ref: source,
              set: { name },
              unset: [],
              reset: [],
            },
          ],
          expectedObjects: [],
          expectedLinks: [],
          expectedLinkScopes: [{ source, linkId: "peers", fingerprint }],
        })
      }

      // Regression guard for G-021: make begin() hydrate the expected scope through the
      // cardinality-one slot reader again and this otherwise unrelated Action commit fails before
      // its already-stable fingerprint can be compared.
      await expect(commitObservation("many-scope-action", "observed peers")).resolves.toMatchObject(
        { kind: "edit", created: true }
      )

      await runtimeMaterializer.edits.commit({
        mode: "atomic",
        source: { kind: "runtime", requestId: "many-scope-change" },
        operations: [{ id: "add-peer", kind: "link.upsert", ref: linkRef("peer-c") }],
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })

      const stale = commitObservation("stale-many-scope-action", "must not commit")
      await expect(stale).rejects.toThrow("Expected link scope changed")
      await expect(stale).rejects.toMatchObject({ kind: "expectation" })
      expect(
        await storage.objects.getByPrimaryId({
          projectId: "materializer-storage-contract",
          objectTypeId: Device.id,
          primaryId: source.primaryId,
        })
      ).toMatchObject({ properties: { name: "observed peers" } })
    } finally {
      await provider.cleanup?.(createdStorage)
    }
  })

  // Removal proof: make every provider's `refresh` answer fresh; the edited object's planned
  // upsert then fails its revision check and the publication rejects.
  test(`${name} plans again only the identity an edit changed while it planned`, async () => {
    const createdStorage = await provider.createStorage()
    const storage = requireContractStorage(createdStorage)
    const runtime = contractMaterializer(storage).withScope(runtimeScope())
    let armed = false
    let edited = false
    const staged: string[] = []
    const observed = observePlanning(storage, async (planned) => {
      if (!armed) return
      staged.push(...planned.map(plannedId))
      if (edited || !planned.some((value) => plannedId(value) === "a")) return
      edited = true
      await runtime.edits.commit({
        mode: "atomic",
        source: { kind: "runtime", requestId: "edit-while-planned" },
        operations: [
          {
            id: "rename",
            kind: "object.patch",
            ref: deviceRef("a"),
            set: { name: "edited" },
            unset: [],
            reset: [],
          },
        ],
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
    })
    const materializer = contractMaterializer(observed)
    try {
      await publishDevices(materializer, storage, 1, [sourceEntry("a", "A"), sourceEntry("b", "B")])
      armed = true
      await publishDevices(materializer, storage, 2, [
        sourceEntry("a", "A2"),
        sourceEntry("b", "B2"),
      ])
      expect(staged.filter((id) => id === "a")).toHaveLength(2)
      expect(staged.filter((id) => id === "b")).toHaveLength(1)
      expect(await device(storage, "a")).toMatchObject({ properties: { name: "edited" } })
      expect(await device(storage, "b")).toMatchObject({ properties: { name: "B2" } })
    } finally {
      await provider.cleanup?.(createdStorage)
    }
  })

  // Removal proof: drop the link expansion from every provider's `refresh`; the link the edit
  // added keeps pointing at the object the publication deleted.
  test(`${name} plans the links an edit adds to an object the projection deletes`, async () => {
    const createdStorage = await provider.createStorage()
    const storage = requireContractStorage(createdStorage)
    const runtime = contractMaterializer(storage).withScope(runtimeScope())
    let armed = false
    const observed = observePlanning(storage, async (planned) => {
      if (!armed || !planned.some(({ identity }) => identity.kind === "link")) return
      armed = false
      await runtime.edits.commit({
        mode: "atomic",
        source: { kind: "runtime", requestId: "link-while-planned" },
        operations: [
          {
            id: "peer",
            kind: "link.upsert",
            ref: { source: deviceRef("c"), linkId: "peers", target: deviceRef("a") },
          },
        ],
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
    })
    const materializer = contractMaterializer(observed)
    try {
      await publishDevices(materializer, storage, 1, [
        sourceEntry("a", "A"),
        sourceEntry("b", "B", "a"),
        sourceEntry("c", "C"),
      ])
      armed = true
      await publishDevices(materializer, storage, 2, [sourceEntry("b", "B"), sourceEntry("c", "C")])
      expect(await device(storage, "a")).toBeNull()
      for (const id of ["b", "c"]) {
        expect(
          await storage.objects.listLinks({
            projectId: CONTRACT_PROJECT,
            objectTypeId: Device.id,
            objectId: id,
          })
        ).toEqual([])
      }
    } finally {
      await provider.cleanup?.(createdStorage)
    }
  })

  // Removal proof: compare a link's edge override by an unqualified `identity_key` in the SQLite
  // revision; it then reads another link's override, and the untouched link is planned again.
  test(`${name} plans again only the link whose override an edit changed while it planned`, async () => {
    const createdStorage = await provider.createStorage()
    const storage = requireContractStorage(createdStorage)
    const runtime = contractMaterializer(storage).withScope(runtimeScope())
    let armed = false
    let edited = false
    const staged: string[] = []
    const observed = observePlanning(storage, async (planned) => {
      if (!armed) return
      const links = planned.flatMap(({ identity }) =>
        identity.kind === "link" ? [identity.ref.source.primaryId] : []
      )
      staged.push(...links)
      if (edited || !links.includes("c")) return
      edited = true
      // Once both links are planned, keeps the one of b the publication retracts; its effective
      // row stays as it was.
      await runtime.edits.commit({
        mode: "atomic",
        source: { kind: "runtime", requestId: "override-while-planned" },
        operations: [
          {
            id: "keep",
            kind: "link.upsert",
            ref: { source: deviceRef("b"), linkId: "parent", target: deviceRef("a") },
          },
        ],
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
    })
    const materializer = contractMaterializer(observed)
    const parent = (id: string) =>
      storage.objects.listLinks({
        projectId: CONTRACT_PROJECT,
        objectTypeId: Device.id,
        objectId: id,
      })
    try {
      await publishDevices(materializer, storage, 1, [
        sourceEntry("a", "A"),
        sourceEntry("b", "B", "a"),
        sourceEntry("c", "C", "a"),
      ])
      armed = true
      await publishDevices(materializer, storage, 2, [
        sourceEntry("a", "A"),
        sourceEntry("b", "B"),
        sourceEntry("c", "C"),
      ])
      expect(staged.filter((id) => id === "b")).toHaveLength(2)
      expect(staged.filter((id) => id === "c")).toHaveLength(1)
      expect(await parent("b")).toHaveLength(1)
      expect(await parent("c")).toEqual([])
    } finally {
      await provider.cleanup?.(createdStorage)
    }
  })

  // Removal proof: make SQLite's plan-bound session compare its watermark with the last commit of
  // any project; the commit then rejects the plan its refresh just found fresh.
  test(`${name} commits a plan another project committed beside`, async () => {
    const createdStorage = await provider.createStorage()
    const storage = requireContractStorage(createdStorage)
    const other = createOntologyMaterializer({
      projectId: "other-project",
      ontology,
      projections,
      storage,
    }).withScope(
      createTestingScope({
        projectId: "other-project",
        executionId: "other-project-runtime-execution",
        requestId: "other-project-runtime-request",
        correlationId: "other-project-runtime-correlation",
      })
    )
    let armed = false
    let staged = 0
    const observed = observePlanning(storage, async (planned) => {
      if (!armed) return
      staged += planned.length
      if (staged !== 1) return
      await other.edits.commit({
        mode: "atomic",
        source: { kind: "runtime", requestId: "other-project-edit" },
        operations: [
          { id: "create", kind: "object.create", ref: deviceRef("x"), properties: { name: "X" } },
        ],
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
    })
    const materializer = contractMaterializer(observed)
    try {
      await publishDevices(materializer, storage, 1, [sourceEntry("a", "A")])
      armed = true
      await publishDevices(materializer, storage, 2, [
        sourceEntry("a", "A2"),
        sourceEntry("b", "B"),
      ])
      expect(staged).toBe(2)
      expect(await device(storage, "b")).toMatchObject({ properties: { name: "B" } })
    } finally {
      await provider.cleanup?.(createdStorage)
    }
  })

  // Removal proof: in PostgreSQL's `committedSince`, count only commits at or past the
  // watermark's xmax; the edit, in flight when the plan opened, is then taken as seen.
  if (provider.concurrentTransactions) {
    test(`${name} plans again what a commit in flight when the plan opened changed`, async () => {
      const createdStorage = await provider.createStorage()
      const storage = requireContractStorage(createdStorage)
      const paused = pauseBeforeFinalize(storage)
      const runtime = contractMaterializer(paused.storage).withScope(runtimeScope())
      let edit: Promise<unknown> | undefined
      let armed = false
      let staged = 0
      const observed = observePlanning(storage, async (planned) => {
        if (!armed) return
        staged += planned.length
        if (staged !== 1) return
        // The page read the object before the edit committed.
        paused.release()
        await edit
      })
      const materializer = contractMaterializer(observed)
      try {
        await publishDevices(materializer, storage, 1, [sourceEntry("a", "A")])
        edit = runtime.edits.commit({
          mode: "atomic",
          source: { kind: "runtime", requestId: "edit-in-flight" },
          operations: [
            {
              id: "rename",
              kind: "object.patch",
              ref: deviceRef("a"),
              set: { name: "edited" },
              unset: [],
              reset: [],
            },
          ],
          expectedObjects: [],
          expectedLinks: [],
          expectedLinkScopes: [],
        })
        // It has written the object and holds its transaction open.
        await paused.reached
        armed = true
        await publishDevices(materializer, storage, 2, [sourceEntry("a", "A2")])
        await edit
        expect(staged).toBe(2)
        expect(await device(storage, "a")).toMatchObject({ properties: { name: "edited" } })
      } finally {
        paused.release()
        await provider.cleanup?.(createdStorage)
      }
    })
  }

  // Removal proof: let the in-memory `streamState` keep the identities it listed instead of
  // looking each page's up again; the rollback restores the plan as copies, and the next page
  // marks as read identities the plan no longer holds.
  test(`${name} keeps planning across a transaction that rolls back meanwhile`, async () => {
    const createdStorage = await provider.createStorage()
    const storage = requireContractStorage(createdStorage)
    let staged = 0
    const observed = observePlanning(storage, async (planned) => {
      staged += planned.length
      if (staged !== 1) return
      await expect(
        storage.transaction(async () => {
          throw new Error("rolled back")
        })
      ).rejects.toThrow("rolled back")
    })
    const materializer = contractMaterializer(observed)
    try {
      await publishDevices(materializer, storage, 1, [sourceEntry("a", "A"), sourceEntry("b", "B")])
      expect(staged).toBe(2)
      expect(await device(storage, "b")).toMatchObject({ properties: { name: "B" } })
    } finally {
      await provider.cleanup?.(createdStorage)
    }
  })

  // Removal proof: in PostgreSQL's `committedSince`, drop the check of a watermark from beyond
  // this snapshot (the stale plan applies and conflicts with the edit), or the filter on commits
  // this snapshot sees (no plan reads as just refreshed again).
  const restoreFromClusterAhead = provider.restoreFromClusterAhead
  if (restoreFromClusterAhead) {
    test(`${name} plans again after a restore from a cluster further along`, async () => {
      const createdStorage = await provider.createStorage()
      const storage = requireContractStorage(createdStorage)
      const runtime = contractMaterializer(storage).withScope(runtimeScope())
      let failNextCommit = false
      let staged = 0
      const observed = observePlanning(
        storage,
        async (planned) => {
          staged += planned.length
        },
        async () => {
          if (!failNextCommit || staged === 0) return
          failNextCommit = false
          throw new Error("commit lost")
        }
      )
      const materializer = contractMaterializer(observed)
      try {
        await publishDevices(materializer, storage, 1, [sourceEntry("a", "A")])
        const execution = await claimDevices(storage, 2)
        failNextCommit = true
        staged = 0
        await expect(
          publishDevices(materializer, storage, 2, [sourceEntry("a", "A2")], execution)
        ).rejects.toThrow("commit lost")
        await runtime.edits.commit({
          mode: "atomic",
          source: { kind: "runtime", requestId: "edit-before-restore" },
          operations: [
            {
              id: "rename",
              kind: "object.patch",
              ref: deviceRef("a"),
              set: { name: "edited" },
              unset: [],
              reset: [],
            },
          ],
          expectedObjects: [],
          expectedLinks: [],
          expectedLinkScopes: [],
        })
        await restoreFromClusterAhead(createdStorage)
        await publishDevices(materializer, storage, 2, [sourceEntry("a", "A2")], execution)
        expect(await device(storage, "a")).toMatchObject({ properties: { name: "edited" } })
      } finally {
        await provider.cleanup?.(createdStorage)
      }
    })
  }

  // Removal proof: let `open` reset an existing plan; the redelivery stages all three identities
  // again. Let it keep the plan but answer the time it was given: the redelivery cannot commit.
  test(`${name} resumes the plan a failed commit left to the next delivery`, async () => {
    const createdStorage = await provider.createStorage()
    const storage = requireContractStorage(createdStorage)
    let failNextCommit = true
    let stagedIdentities = 0
    let plannedAt: string | undefined
    const observed = observePlanning(
      storage,
      async (planned) => {
        stagedIdentities += planned.length
        for (const record of planned.flatMap(({ records }) => records)) {
          if (record.kind === "event") plannedAt ??= record.draft.occurredAt
        }
      },
      async () => {
        // Admission opens a transaction before anything is planned: fail the commit's.
        if (!failNextCommit || stagedIdentities === 0) return
        failNextCommit = false
        throw new Error("commit lost")
      }
    )
    const materializer = contractMaterializer(observed)
    try {
      const execution = await claimDevices(storage, 1)
      const values = [sourceEntry("a", "A"), sourceEntry("b", "B", "a")]
      await expect(publishDevices(materializer, storage, 1, values, execution)).rejects.toThrow(
        "commit lost"
      )
      expect(stagedIdentities).toBe(3)
      // The redelivery's clock has moved on; its commit keeps the time its events were planned at.
      await new Promise((resolve) => setTimeout(resolve, 5))
      const result = await publishDevices(materializer, storage, 1, values, execution)
      expect(stagedIdentities).toBe(3)
      expect(result.committedAt).toBe(plannedAt!)
      expect(await device(storage, "b")).toMatchObject({ properties: { name: "B" } })
    } finally {
      await provider.cleanup?.(createdStorage)
    }
  })

  // Removal proof: let `open` resume a plan whatever source it replaces; the redelivery then
  // keeps an entity only the newer active source asserted, or rejects its own activation.
  test(`${name} plans again from scratch when the source a plan replaces moved`, async () => {
    const createdStorage = await provider.createStorage()
    const storage = requireContractStorage(createdStorage)
    let failNextCommit = false
    let staged = 0
    const observed = observePlanning(
      storage,
      async (planned) => {
        staged += planned.length
      },
      async () => {
        if (!failNextCommit || staged === 0) return
        failNextCommit = false
        throw new Error("commit lost")
      }
    )
    const materializer = contractMaterializer(observed)
    try {
      await publishDevices(materializer, storage, 1, [sourceEntry("a", "A")])
      const execution = await claimDevices(storage, 3)
      failNextCommit = true
      staged = 0
      await expect(
        publishDevices(materializer, storage, 3, [sourceEntry("a", "A3")], execution)
      ).rejects.toThrow("commit lost")
      await publishDevices(materializer, storage, 2, [
        sourceEntry("a", "A2"),
        sourceEntry("z", "Z"),
      ])
      staged = 0
      await publishDevices(materializer, storage, 3, [sourceEntry("a", "A3")], execution)
      expect(staged).toBe(2)
      expect(await device(storage, "a")).toMatchObject({ properties: { name: "A3" } })
      expect(await device(storage, "z")).toBeNull()
    } finally {
      await provider.cleanup?.(createdStorage)
    }
  })

  // Removal proof: drop the round bound in `commitProjectionCandidate`; the delivery plans again
  // after every edit and never returns.
  test(`${name} gives the delivery back when an identity keeps changing while planned`, async () => {
    const createdStorage = await provider.createStorage()
    const storage = requireContractStorage(createdStorage)
    const runtime = contractMaterializer(storage).withScope(runtimeScope())
    let armed = false
    let edits = 0
    const observed = observePlanning(storage, async (planned) => {
      if (!armed || !planned.some((value) => plannedId(value) === "a")) return
      edits += 1
      await runtime.edits.commit({
        mode: "atomic",
        source: { kind: "runtime", requestId: `keeps-changing-${edits}` },
        operations: [
          {
            id: "rename",
            kind: "object.patch",
            ref: deviceRef("a"),
            set: { name: `e${edits}` },
            unset: [],
            reset: [],
          },
        ],
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
    })
    const materializer = contractMaterializer(observed)
    try {
      await publishDevices(materializer, storage, 1, [sourceEntry("a", "A")])
      armed = true
      await expect(
        publishDevices(materializer, storage, 2, [sourceEntry("a", "A2")])
      ).rejects.toMatchObject({
        kind: "effective-state",
        message: expect.stringContaining("(1 changed during the last of 3 rounds)"),
      })
      expect(edits).toBe(3)
    } finally {
      await provider.cleanup?.(createdStorage)
    }
  })

  // Removal proof: let `purge` take plans whose candidate is still ready; the second delivery
  // then plans every identity again instead of resuming. Let it stop after one plan: a second
  // call still finds the other.
  test(`${name} purges only the plans of candidates that moved on`, async () => {
    const createdStorage = await provider.createStorage()
    const storage = requireContractStorage(createdStorage)
    let interrupt = false
    let staged = 0
    const observed = observePlanning(storage, async (planned) => {
      staged += planned.length
      if (interrupt && staged === 1) throw new Error("delivery lost")
    })
    const materializer = contractMaterializer(observed)
    const purgeAll = async () => {
      let rounds = 0
      while (
        (await storage.ontology.replacementPlans.purge({ projectId: CONTRACT_PROJECT, limit: 2 })) >
        0
      ) {
        rounds += 1
        if (rounds > 100) throw new Error("Plan purge never ran out.")
      }
    }
    try {
      await publishDevices(materializer, storage, 1, [sourceEntry("a", "A"), sourceEntry("b", "B")])
      await purgeAll()
      const execution = await claimDevices(storage, 2)
      const values = [sourceEntry("a", "A2"), sourceEntry("c", "C")]
      interrupt = true
      staged = 0
      await expect(publishDevices(materializer, storage, 2, values, execution)).rejects.toThrow(
        "delivery lost"
      )
      interrupt = false
      await purgeAll()
      staged = 0
      await publishDevices(materializer, storage, 2, values, execution)
      expect(staged).toBe(2)
      // Two spent plans: one call within its budget purges both.
      await publishDevices(materializer, storage, 3, values)
      await storage.ontology.replacementPlans.purge({ projectId: CONTRACT_PROJECT, limit: 1_000 })
      expect(
        await storage.ontology.replacementPlans.purge({ projectId: CONTRACT_PROJECT, limit: 1_000 })
      ).toBe(0)
      expect(await device(storage, "a")).toMatchObject({ properties: { name: "A2" } })
      expect(await device(storage, "b")).toBeNull()
      expect(await device(storage, "c")).toMatchObject({ properties: { name: "C" } })
    } finally {
      await provider.cleanup?.(createdStorage)
    }
  })
}

function runtimeScope() {
  return createTestingScope({
    projectId: "materializer-storage-contract",
    executionId: "materializer-storage-contract-runtime-execution",
    requestId: "materializer-storage-contract-runtime-request",
    correlationId: "materializer-storage-contract-runtime-correlation",
  })
}

async function projectionMaterializer(
  materializer: OntologyMaterializer,
  storage: ContractStorage,
  projectionId: string,
  runId: string
) {
  return primitiveMaterializer(materializer, storage, {
    kind: "projection",
    id: projectionId,
    runId,
  })
}

async function primitiveMaterializer(
  materializer: OntologyMaterializer,
  storage: ContractStorage,
  primitive: TrustedPrimitiveRef
) {
  const run =
    primitive.kind === "action"
      ? await storage.actionRuns.getById({
          projectId: "materializer-storage-contract",
          id: primitive.runId,
        })
      : await storage.projectionRuns.getById({
          projectId: "materializer-storage-contract",
          id: primitive.runId,
        })
  const executionId = run?.executionId ?? `test_${primitive.kind}_execution:${primitive.runId}`
  const execution = await storage.executions.getById({
    projectId: "materializer-storage-contract",
    id: executionId,
  })
  if (!execution) throw new Error(`Test execution '${executionId}' is missing.`)
  return materializer.withScope(restoreTrustedPrimitiveExecutionScope({ execution, primitive }))
}

function requireContractStorage(storage: Storage): ContractStorage {
  if (!storage.actionRuns) {
    throw new Error("[Sixb] Materializer storage contract requires Action materialization runs.")
  }
  if (!storage.projectionRuns) {
    throw new Error(
      "[Sixb] Materializer storage contract requires projection materialization runs."
    )
  }
  return storage as ContractStorage
}

function sourceEntry(id: string, name: string, parentId?: string): ProjectionSourceEntry {
  const ref = { objectTypeId: Device.id, primaryId: id }
  return {
    root: { kind: "object", ref },
    assertions: [
      { kind: "object", ref, properties: { name } },
      ...(parentId
        ? [
            {
              kind: "link" as const,
              ref: {
                source: ref,
                linkId: "parent",
                target: { objectTypeId: Device.id, primaryId: parentId },
              },
            },
          ]
        : []),
    ],
  }
}

async function* entries(values: readonly (ProjectionSourceEntry | ProjectionSourceDeletion)[]) {
  for (const value of values) yield value
}

async function claim(
  storage: ContractStorage,
  input: {
    readonly runId: string
    readonly projectionId: string
    readonly protocol: "replacement" | "telemetry"
    readonly datasetVersion: {
      readonly datasetId: string
      readonly versionId: string
      readonly createdAt: string
    }
    readonly fixedBatchSize?: number
  }
) {
  const resolved =
    input.protocol === "replacement"
      ? projections.resolveSource(input.projectionId)
      : projections.resolveTelemetry(input.projectionId)
  const definition = resolved.definition
  const identityBase = {
    projectionId: input.projectionId,
    datasetVersion: input.datasetVersion,
    ontologyRevision: projections.ontologyRevision,
    projectionRevision: resolved.projectionRevision,
    ownershipHash: resolved.ownershipHash,
  }
  const common = {
    id: input.runId,
    projectId: "materializer-storage-contract",
  } as const

  if (definition._tag === "TelemetryProjectionDefinition") {
    const claim = await startTestProjectionRun(storage, {
      ...common,
      identity: { ...identityBase, projectionKind: "telemetry", protocol: "telemetry" },
      target: { objectTypeId: definition.objectTypeId },
      fixedBatchSize: input.fixedBatchSize ?? 1,
    })
    return claim.execution
  }

  if (definition._tag === "LinkProjectionDefinition") {
    const claim = await startTestProjectionRun(storage, {
      ...common,
      identity: { ...identityBase, projectionKind: "link", protocol: "replacement" },
      target: {
        sourceObjectTypeId: definition.sourceObjectTypeId,
        targetObjectTypeId: definition.targetObjectTypeId,
      },
    })
    return claim.execution
  }

  const claim = await startTestProjectionRun(storage, {
    ...common,
    identity: { ...identityBase, projectionKind: "object", protocol: "replacement" },
    target: { objectTypeId: definition.objectTypeId },
  })
  return claim.execution
}

const CONTRACT_PROJECT = "materializer-storage-contract"

function contractMaterializer(storage: Storage): OntologyMaterializer {
  return createOntologyMaterializer({
    projectId: CONTRACT_PROJECT,
    ontology,
    projections,
    storage,
    dependencies: { batching: { sourceStageRows: 1, statePageRows: 1, planChunkRows: 1 } },
  })
}

function deviceRef(primaryId: string) {
  return { objectTypeId: Device.id, primaryId }
}

function device(storage: ContractStorage, primaryId: string) {
  return storage.objects.getByPrimaryId({ projectId: CONTRACT_PROJECT, ...deviceRef(primaryId) })
}

function plannedId({ identity }: PlannedReplacementIdentity): string {
  return identity.kind === "object" ? identity.ref.primaryId : "link"
}

/**
 * The same storage, whose plan staging runs `afterStage` once a page is staged and whose
 * transactions run `beforeTransaction` first: a way to interleave writes with a projection's plan.
 */
function observePlanning(
  storage: ContractStorage,
  afterStage: (planned: readonly PlannedReplacementIdentity[]) => Promise<void>,
  beforeTransaction?: () => Promise<void>
): ContractStorage {
  const plans = storage.ontology.replacementPlans
  const observed: OntologyReplacementPlanStorage = {
    open: (input) => plans.open(input),
    streamState: (input) => plans.streamState(input),
    async stage(input) {
      await plans.stage(input)
      await afterStage(input.planned)
    },
    refresh: (input) => plans.refresh(input),
    purge: (input) => plans.purge(input),
  }
  const ontologyFacade = new Proxy(storage.ontology, {
    get(target, property) {
      if (property === "replacementPlans") return observed
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return new Proxy(storage, {
    get(target, property) {
      if (property === "ontology") return ontologyFacade
      if (property === "transaction" && beforeTransaction) {
        return async (...args: Parameters<Storage["transaction"]>) => {
          await beforeTransaction()
          return target.transaction(...args)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

/** The same storage, whose transactions wait before they finalize until `release` is called. */
function pauseBeforeFinalize(storage: ContractStorage) {
  let reach!: () => void
  const reached = new Promise<void>((resolve) => {
    reach = resolve
  })
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const paused = new Proxy(storage, {
    get(target, property) {
      if (property !== "transaction") {
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      }
      return (run: (tx: Storage) => unknown, options?: Parameters<Storage["transaction"]>[1]) =>
        target.transaction((tx) => {
          const materializations = new Proxy(tx.ontology.materializations, {
            get(store, key) {
              const value = Reflect.get(store, key, store)
              if (key !== "finalize") return typeof value === "function" ? value.bind(store) : value
              return async (...args: Parameters<typeof store.finalize>) => {
                reach()
                await released
                return store.finalize(...args)
              }
            },
          })
          const ontology = new Proxy(tx.ontology, {
            get: (store, key) =>
              key === "materializations" ? materializations : Reflect.get(store, key, store),
          })
          return run(
            new Proxy(tx, {
              get: (store, key) => (key === "ontology" ? ontology : Reflect.get(store, key, store)),
            })
          )
        }, options)
    },
  })
  return { storage: paused, reached, release }
}

function deviceVersion(version: number) {
  return {
    datasetId: devices.id,
    versionId: `plan-v${version}`,
    createdAt: `2026-02-${String(version).padStart(2, "0")}T00:00:00.000Z`,
  }
}

function claimDevices(storage: ContractStorage, version: number): Promise<ProjectionExecution> {
  return claim(storage, {
    runId: `plan-run-${version}`,
    projectionId: devices.id,
    protocol: "replacement",
    datasetVersion: deviceVersion(version),
  })
}

async function publishDevices(
  materializer: OntologyMaterializer,
  storage: ContractStorage,
  version: number,
  values: readonly ProjectionSourceEntry[],
  execution?: ProjectionExecution
) {
  const claimed = execution ?? (await claimDevices(storage, version))
  const bound = await projectionMaterializer(
    materializer,
    storage,
    devices.id,
    claimed.projectionRunId
  )
  return bound.projections.replace({
    source: { projectionId: devices.id },
    datasetVersion: deviceVersion(version),
    execution: claimed,
    entries: entries(values),
  })
}
