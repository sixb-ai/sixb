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
  ProjectionRegistry,
  type ProjectionSourceEntry,
} from "../src/materializer"

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
  const materializer = createOntologyMaterializer({
    projectId: "project",
    ontology,
    projections,
    storage,
    dependencies: {
      clock: () => new Date("2026-01-02T03:04:05.000Z"),
      generationId: generationSequence(),
      ...input.dependencies,
    },
  })
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
    projectionRunId: runId,
    entries: entries(values),
  } as const
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

function generationSequence(): () => string {
  let value = 0
  return () => `generation-${++value}`
}
