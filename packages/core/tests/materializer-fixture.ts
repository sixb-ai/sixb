import {
  col,
  type DatasetDefinition,
  defineDataset,
  defineObjectType,
  defineProjection,
  defineTelemetryProjection,
  InMemoryStorage,
  link,
  OntologyRegistry,
  prop,
} from "../src"
import {
  createOntologyMaterializer,
  type OntologyMaterializerDependencies,
  type PinnedDatasetVersion,
  type ProjectionExecution,
  ProjectionRegistry,
  type ProjectionSourceEntry,
  type ProjectionSourceReplacement,
  type TelemetryAppend,
} from "../src/materializer"
import type { ProjectionRunMaterializationIdentity } from "../src/storage"

export const Device = defineObjectType({
  id: "Device",
  name: "Device",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("name", "string", { required: true }),
    prop("note", "string", { nullable: true }),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
  links: [link.self("parent", { cardinality: "one" }), link.self("peers", { cardinality: "many" })],
})

const devices = defineDataset("devices", {
  schema: [
    col("id", "string"),
    col("name", "string"),
    col("note", "string", { nullable: true }),
    col("parent_id", "string", { nullable: true }),
  ],
})
const readings = defineDataset("readings", {
  schema: [col("device_id", "string"), col("at", "timestamp"), col("value", "float64")],
})
const deviceProjection = defineProjection("devices", Device)
  .fromDataset(devices)
  .properties({ id: "id", name: "name", note: "note" })
  .withLinks({
    parent: {
      link: Device.l.parent,
      sourceField: "parent_id",
      target: Device,
    },
  })
const temperatureProjection = defineTelemetryProjection("temperatures", Device.p.temperature)
  .fromDataset(readings)
  .points({ objectId: "device_id", at: "at", value: "value" })

export function createMaterializerFixture(
  input: {
    readonly dependencies?: OntologyMaterializerDependencies
    readonly storage?: InMemoryStorage
  } = {}
) {
  const ontology = new OntologyRegistry({ sources: [Device] })
  const projections = new ProjectionRegistry({
    projections: [deviceProjection, temperatureProjection],
    ontology,
    datasetsById: new Map<string, DatasetDefinition>([
      [devices.id, devices],
      [readings.id, readings],
    ]),
  })
  const storage = input.storage ?? new InMemoryStorage()
  const baseMaterializer = createOntologyMaterializer({
    projectId: "project",
    ontology,
    projections,
    storage,
    dependencies: {
      clock: () => new Date("2026-01-02T03:04:05.000Z"),
      materializationId: materializationSequence(),
      ...input.dependencies,
    },
  })
  const materializer = {
    edits: baseMaterializer.edits,
    projections: {
      async replace(request: ProjectionSourceReplacement) {
        const execution = await resolveFixtureExecution(storage, projections, request.execution, {
          projectionId: request.source.projectionId,
          protocol: "replacement",
          datasetVersion: request.datasetVersion,
        })
        return baseMaterializer.projections.replace({ ...request, execution })
      },
    },
    telemetry: {
      async append(request: TelemetryAppend) {
        if (
          request.source.kind !== "projection" ||
          request.source.execution.executionToken !== FIXTURE_EXECUTION_TOKEN
        ) {
          return baseMaterializer.telemetry.append(request)
        }
        const execution = await claimProjectionExecution(storage, projections, {
          runId: request.source.execution.projectionRunId,
          projectionId: request.source.projection.projectionId,
          protocol: "telemetry",
          datasetVersion: request.source.datasetVersion,
          fixedBatchSize: request.source.sourceRowCount,
        })
        return baseMaterializer.telemetry.append({
          ...request,
          source: { ...request.source, execution },
        })
      },
    },
  }
  return { materializer, storage, ontology, projections }
}

export function sourceEntry(id: string, name: string, note?: string | null): ProjectionSourceEntry {
  return {
    root: { kind: "object", ref: { objectTypeId: "Device", primaryId: id } },
    assertions: [
      {
        kind: "object",
        ref: { objectTypeId: "Device", primaryId: id },
        properties: { name, ...(note !== undefined ? { note } : {}) },
      },
    ],
  }
}

export function sourceEntryWithParent(
  id: string,
  name: string,
  parentId: string
): ProjectionSourceEntry {
  const object = sourceEntry(id, name)
  return {
    ...object,
    assertions: [
      ...object.assertions,
      {
        kind: "link",
        ref: {
          source: { objectTypeId: "Device", primaryId: id },
          linkId: "parent",
          target: { objectTypeId: "Device", primaryId: parentId },
        },
      },
    ],
  }
}

export async function* entries(
  values: readonly ProjectionSourceEntry[]
): AsyncIterable<ProjectionSourceEntry> {
  for (const value of values) yield value
}

export function replacement(
  versionId: string,
  createdAt: string,
  values: readonly ProjectionSourceEntry[],
  runId = `run-${versionId}`
) {
  return {
    source: { projectionId: "devices" },
    datasetVersion: { datasetId: "devices", versionId, createdAt },
    execution: pendingProjectionExecution(runId),
    entries: entries(values),
  } as const
}

const FIXTURE_EXECUTION_TOKEN = "__fixture_claim__"

export function pendingProjectionExecution(projectionRunId: string): ProjectionExecution {
  return { projectionRunId, executionToken: FIXTURE_EXECUTION_TOKEN }
}

export async function claimProjectionExecution(
  storage: InMemoryStorage,
  projections: ProjectionRegistry,
  input: {
    readonly runId: string
    readonly projectionId: string
    readonly protocol: "replacement" | "telemetry"
    readonly datasetVersion: PinnedDatasetVersion
    readonly fixedBatchSize?: number
  }
): Promise<ProjectionExecution> {
  const resolved =
    input.protocol === "replacement"
      ? projections.resolveSource(input.projectionId)
      : projections.resolveTelemetry(input.projectionId)
  const definition = resolved.definition
  const projectionKind =
    definition._tag === "ObjectProjectionDefinition"
      ? "object"
      : definition._tag === "LinkProjectionDefinition"
        ? "link"
        : "telemetry"
  const identityBase = {
    projectionId: resolved.projectionId,
    datasetVersion: {
      ...input.datasetVersion,
      createdAt: new Date(input.datasetVersion.createdAt).toISOString(),
    },
    ontologyRevision: projections.ontologyRevision,
    projectionRevision: resolved.projectionRevision,
    ownershipHash: resolved.ownershipHash,
  }
  let identity: ProjectionRunMaterializationIdentity
  if (input.protocol === "telemetry") {
    identity = { ...identityBase, projectionKind: "telemetry", protocol: "telemetry" }
  } else {
    if (projectionKind === "telemetry") {
      throw new Error("Replacement execution requires an object or link projection")
    }
    identity = { ...identityBase, projectionKind, protocol: "replacement" }
  }
  const objectTypes =
    definition._tag === "LinkProjectionDefinition"
      ? {
          sourceObjectTypeId: definition.sourceObjectTypeId,
          targetObjectTypeId: definition.targetObjectTypeId,
        }
      : { objectTypeId: definition.objectTypeId }
  const run = await storage.projectionRuns.startOrReclaimMaterialization({
    id: input.runId,
    projectId: "project",
    identity,
    ...objectTypes,
    ...(input.fixedBatchSize !== undefined ? { fixedBatchSize: input.fixedBatchSize } : {}),
  })
  if (!run.executionToken) throw new Error("Fixture projection claim returned no execution token")
  return { projectionRunId: run.id, executionToken: run.executionToken }
}

async function resolveFixtureExecution(
  storage: InMemoryStorage,
  projections: ProjectionRegistry,
  execution: ProjectionExecution,
  input: {
    readonly projectionId: string
    readonly protocol: "replacement"
    readonly datasetVersion: PinnedDatasetVersion
  }
): Promise<ProjectionExecution> {
  if (execution.executionToken !== FIXTURE_EXECUTION_TOKEN) return execution
  return claimProjectionExecution(storage, projections, {
    ...input,
    runId: execution.projectionRunId,
  })
}

export function atomic(
  requestId: string,
  operations: readonly import("../src/materializer").OntologyEditOperation[]
) {
  return {
    mode: "atomic",
    source: { kind: "runtime", requestId },
    operations,
    expectedObjects: [],
    expectedLinks: [],
    expectedLinkScopes: [],
  } as const
}

function materializationSequence(): () => string {
  let value = 0
  return () => `materialization-${++value}`
}
