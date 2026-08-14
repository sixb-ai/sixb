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
import {
  createOntologyMaterializer,
  type OntologyEditOperation,
  ProjectionRegistry,
  type ProjectionSourceEntry,
} from "../materializer"
import type { ActionRunStorage, ProjectionRunStorage } from "../storage"
import { queueTestActionRun } from "./action-execution"

export interface MaterializerStorageContractProvider<TStorage extends Storage> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
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
  links: [link.self("parent", { cardinality: "one" })],
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

const ontology = new OntologyRegistry({ sources: [Device] })
const projections = new ProjectionRegistry({
  projections: [deviceProjection, temperatureProjection],
  ontology,
  datasetsById: new Map<string, DatasetDefinition>([
    [devices.id, devices],
    [readings.id, readings],
  ]),
})

export function runMaterializerStorageContractSuite<TStorage extends Storage>(
  name: string,
  provider: MaterializerStorageContractProvider<TStorage>
): void {
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
      const first = await materializer.projections.replace({
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
      const second = await materializer.projections.replace({
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

      await expect(
        materializer.edits.commit({
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
      const actionCommit = await materializer.edits.commit({
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
      await expect(
        materializer.telemetry.append({
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
      const telemetry = await materializer.telemetry.append({
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
      await materializer.projections.replace({
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
      materializer.edits.commit({
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

async function* entries(values: readonly ProjectionSourceEntry[]) {
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
    const claim = await storage.projectionRuns.startOrReclaim({
      ...common,
      identity: { ...identityBase, projectionKind: "telemetry", protocol: "telemetry" },
      target: { objectTypeId: definition.objectTypeId },
      fixedBatchSize: input.fixedBatchSize ?? 1,
    })
    return claim.execution
  }

  if (definition._tag === "LinkProjectionDefinition") {
    const claim = await storage.projectionRuns.startOrReclaim({
      ...common,
      identity: { ...identityBase, projectionKind: "link", protocol: "replacement" },
      target: {
        sourceObjectTypeId: definition.sourceObjectTypeId,
        targetObjectTypeId: definition.targetObjectTypeId,
      },
    })
    return claim.execution
  }

  const claim = await storage.projectionRuns.startOrReclaim({
    ...common,
    identity: { ...identityBase, projectionKind: "object", protocol: "replacement" },
    target: { objectTypeId: definition.objectTypeId },
  })
  return claim.execution
}
