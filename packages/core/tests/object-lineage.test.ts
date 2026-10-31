import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import {
  can,
  col,
  type DatasetDefinition,
  type DatasetRow,
  type DatasetVersion,
  defineAction,
  defineDataset,
  defineGroup,
  defineMarking,
  defineObjectType,
  defineProjection,
  defineRole,
  type EventExecutor,
  link,
  OntologyRegistry,
  param,
  prop,
  SixbHost,
} from "../src"
import { lakeDatasetDefinition } from "../src/datasets/write"
import { type DatasetColumnLineage, InMemoryLakeStorage } from "../src/lake-storage"
import {
  createOntologyMaterializer,
  type PinnedDatasetVersion,
  ProjectionRegistry,
  type ProjectionSourceEntry,
  type TelemetryPointWrite,
} from "../src/materializer"
import { createTestSixb } from "../src/testing"
import { contextIn } from "./helpers/view-conditions"
import { claimProjectionExecution, projectionScope } from "./materializer-fixture"
import { createSharedTestScope } from "./shared-test-scope"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A plant whose devices come from a normalized dataset, which a pipeline computes from the raw
// export of its maintenance system. Operators rename devices and clear their notes through
// Actions; sensors report temperatures.

// The projection test helpers claim runs in this project.
const projectId = "project"

const T0 = "2026-03-01T00:00:00.000Z"
const T1 = "2026-03-01T00:01:00.000Z"
const T2 = "2026-03-01T00:02:00.000Z"

const confidential = defineMarking("confidential")

const Device = defineObjectType({
  id: "Device",
  name: "Device",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("name", "string"),
    prop("note", "string", { nullable: true }),
    prop("status", "string", { query: { searchable: true, filterable: true } }),
    prop("serial", "string", { markings: [confidential] }),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
  links: [link.self("parent", { cardinality: "one" }), link.self("peers", { cardinality: "many" })],
})

const rawDevices = defineDataset("raw_devices", {
  schema: [
    col("device_id", "string"),
    col("device_name", "string"),
    col("note", "string", { nullable: true }),
    col("status", "string"),
    col("serial", "string"),
    col("parent_id", "string", { nullable: true }),
    col("updated_at", "timestamp"),
  ],
})
const devices = defineDataset("devices", {
  schema: [
    col("id", "string"),
    col("name", "string"),
    col("note", "string", { nullable: true }),
    col("status", "string"),
    col("serial", "string"),
    col("parent_id", "string", { nullable: true }),
    col("updated_at", "timestamp"),
  ],
})
const devicePeers = defineDataset("device_peers", {
  schema: [col("device_id", "string"), col("peer_id", "string")],
})
const readings = defineDataset("readings", {
  schema: [col("device_id", "string"), col("at", "timestamp"), col("temperature", "float64")],
})
const datasets = [rawDevices, devices, devicePeers, readings]

function devicesProjection(strategy: "editsWin" | "mostRecent") {
  const projection = defineProjection("devices", Device)
    .fromDataset(devices)
    .properties({ id: "id", name: "name", note: "note", status: "status", serial: "serial" })
    .withLinks({ parent: { link: Device.l.parent, sourceField: "parent_id", target: Device } })

  return strategy === "mostRecent"
    ? projection.resolveConflicts({ strategy: "mostRecent", sourceTimestamp: "updated_at" })
    : projection
}
const peersProjection = defineProjection("device-peers", Device.l.peers)
  .fromDataset(devicePeers)
  .sourceField("device_id")
  .targetField("peer_id")
const readingsProjection = defineProjection("readings", Device)
  .fromDataset(readings)
  .points({ objectId: "device_id", at: "at", properties: { temperature: "temperature" } })

const rename = defineAction("rename-device")
  .on(Device)
  .params({ name: param("string") })
  .edits(({ objects, subject, params }) => {
    objects(Device).byId(subject.primaryId).update({ name: params.name })
  })
const clearNote = defineAction("clear-note")
  .on(Device)
  .params({})
  .edits(({ objects, subject }) => {
    objects(Device).byId(subject.primaryId).unset("note")
  })
// A writeback may only append telemetry: its commit runs under the Action's execution.
const readTemperature = defineAction("read-temperature")
  .on(Device)
  .params({})
  .writeback(async ({ sixb, target }) => {
    await sixb
      .objects(Device)
      .appendTelemetryBatch([
        { id: target.primaryId, properties: { temperature: 19 }, at: new Date(T0) },
      ])
  })
const register = defineAction("register-device")
  .params({ id: param("string") })
  .edits(({ objects, params }) => {
    objects(Device).create({ id: params.id, name: "Registered", status: "active" })
  })

const operators = defineGroup("operators")
const analysts = defineGroup("analysts")
const viewers = defineGroup("viewers")
const watchers = defineGroup("watchers")

const roles = [
  defineRole("operator", {
    grantedTo: [operators],
    grants: [
      can.view(Device),
      can.edit(Device),
      can.apply([rename, clearNote, readTemperature, register]),
      can.view(datasets),
    ],
    clearances: [confidential],
  }),
  // Reads devices and the normalized dataset, not the raw export, nor runs, nor confidential values.
  defineRole("analyst", {
    grantedTo: [analysts],
    grants: [can.view(Device), can.view(devices)],
  }),
  // Reads devices and nothing else.
  defineRole("viewer", { grantedTo: [viewers], grants: [can.view(Device)] }),
  // Reads active devices only.
  defineRole("watcher", {
    grantedTo: [watchers],
    grants: [can.view(Device).where((device) => device.p.status.eq("active")), can.view(datasets)],
    clearances: [confidential],
  }),
]

const operator = { type: "user", id: "usr_operator" } as const
const device = (primaryId: string) =>
  ({ kind: "object", objectTypeId: Device.id, primaryId }) as const

afterEach(() => {
  setSystemTime()
})

async function deploy(strategy: "editsWin" | "mostRecent" = "editsWin") {
  const deps = createTestRuntimeDeps()
  const lake = new InMemoryLakeStorage()
  const projections = [devicesProjection(strategy), peersProjection, readingsProjection]
  const host = new SixbHost({
    id: projectId,
    ontology: [Device],
    markings: [confidential],
    datasets,
    projections,
    actions: [rename, clearNote, readTemperature, register],
    groups: [operators, analysts, viewers, watchers],
    roles,
    ...deps,
    lakeStorage: lake,
  })
  // A run's requester must exist in the project.
  await deps.storage.auth.users.create({
    projectId,
    id: operator.id,
    email: "operator@example.com",
  })

  // The projection worker's half: a materializer over the host's storage, fed the entries the
  // worker would map from each version's rows.
  const ontology = new OntologyRegistry({ sources: [Device] })
  const registry = new ProjectionRegistry({
    projections,
    ontology,
    datasetsById: new Map<string, DatasetDefinition>(
      datasets.map((dataset) => [dataset.id, dataset])
    ),
  })
  const materializer = createOntologyMaterializer({
    projectId,
    ontology,
    projections: registry,
    storage: deps.storage,
  })

  const claim = async (
    projectionId: string,
    version: DatasetVersion,
    protocol: "replacement" | "telemetry"
  ) => {
    const datasetVersion = pinned(version)
    const runId = `run-${projectionId}-${version.versionId}`
    const execution = await claimProjectionExecution(deps.storage, registry, {
      runId,
      projectionId,
      protocol,
      datasetVersion,
    })
    const scope = await projectionScope(deps.storage, { projectId, projectionId, runId })
    return { runId, datasetVersion, execution, projection: materializer.withScope(scope) }
  }

  /** Apply a version through a projection run. */
  const apply = async (
    projectionId: string,
    version: DatasetVersion,
    entries: readonly ProjectionSourceEntry[]
  ) => {
    const { runId, datasetVersion, execution, projection } = await claim(
      projectionId,
      version,
      "replacement"
    )
    await projection.projections.replace({
      source: { projectionId },
      datasetVersion,
      execution,
      entries: iterate(entries),
    })
    return runId
  }

  /** Append a version's points through the telemetry projection, in one batch. */
  const appendReadings = async (version: DatasetVersion, points: TelemetryPointWrite[]) => {
    const { datasetVersion, execution, projection } = await claim(
      readingsProjection.id,
      version,
      "telemetry"
    )
    return projection.telemetry.append({
      source: {
        kind: "projection",
        projection: { projectionId: readingsProjection.id },
        datasetVersion,
        execution,
        batchOrdinal: 0,
        sourceRowCount: points.length,
        sourceRowsSkipped: 0,
        inputExhausted: true,
      },
      points,
    })
  }

  const trusted = createTestSixb(host)
  const readerIn = (groupIds: readonly string[]) =>
    createTestSixb(host, { authorization: contextIn(host, groupIds, operator) })

  return { host, lake, deps, trusted, readerIn, apply, appendReadings }
}

type Plant = Awaited<ReturnType<typeof deploy>>

/**
 * The raw export, the normalized version a pipeline computed from it, and its projection. d1 is a
 * pump under the valve d2; d3 is retired.
 */
async function seed(plant: Plant, updatedAt = T0, lineage = normalizedLineage) {
  setSystemTime(new Date(updatedAt))

  const rows = [
    { id: "d1", name: "Pump", note: "Primary", status: "active", serial: "SN-1", parent: "d2" },
    { id: "d2", name: "Valve", note: null, status: "active", serial: "SN-2", parent: null },
    { id: "d3", name: "Old pump", note: null, status: "retired", serial: "SN-3", parent: null },
  ] as const

  const raw = await commit(
    plant.lake,
    rawDevices,
    rows.map(({ id, name, parent, ...row }) => ({
      ...row,
      device_id: id,
      device_name: name,
      parent_id: parent,
      updated_at: updatedAt,
    }))
  )
  const normalized = await commit(
    plant.lake,
    devices,
    rows.map(({ parent, ...row }) => ({ ...row, parent_id: parent, updated_at: updatedAt })),
    { inputs: [raw], lineage }
  )
  const runId = await plant.apply(
    "devices",
    normalized,
    rows.map(({ id, parent, ...properties }) => deviceEntry(id, properties, { parent, updatedAt }))
  )

  return { raw, normalized, runId }
}

/** How the pipeline computes each normalized column from the raw export. */
const normalizedLineage: DatasetColumnLineage = {
  rows: [],
  columns: Object.fromEntries(
    ["id", "name", "note", "status", "serial", "parent_id", "updated_at"].map((name) => [
      name,
      [
        {
          datasetId: rawDevices.id,
          column: name === "id" ? "device_id" : name === "name" ? "device_name" : name,
        },
      ],
    ])
  ),
}

function deviceEntry(
  id: string,
  properties: Readonly<Record<string, string | null>>,
  options: { readonly parent: string | null; readonly updatedAt: string }
): ProjectionSourceEntry {
  const ref = { objectTypeId: Device.id, primaryId: id }
  return {
    root: { kind: "object", ref },
    assertions: [
      {
        kind: "object",
        ref,
        properties,
        // `editsWin` drops it; `mostRecent` compares it with edit times.
        sourceUpdatedAt: options.updatedAt,
      },
      ...(options.parent === null
        ? []
        : [
            {
              kind: "link" as const,
              ref: {
                source: ref,
                linkId: "parent",
                target: { objectTypeId: Device.id, primaryId: options.parent },
              },
            },
          ]),
    ],
  }
}

async function commit(
  lake: InMemoryLakeStorage,
  dataset: DatasetDefinition,
  rows: readonly DatasetRow[],
  pipeline?: { readonly inputs: readonly DatasetVersion[]; readonly lineage: DatasetColumnLineage }
): Promise<DatasetVersion> {
  const definition = lakeDatasetDefinition(dataset)
  await lake.createDataset(definition)

  const session = await lake.beginWrite({
    dataset: definition,
    mode: "snapshot",
    producer: pipeline
      ? { kind: "pipeline", id: "normalize-devices", stepId: "normalize" }
      : { kind: "sync", id: "maintenance-export" },
    ...(pipeline
      ? {
          inputs: pipeline.inputs.map(({ datasetId, versionId }) => ({ datasetId, versionId })),
          lineage: pipeline.lineage,
        }
      : {}),
  })

  await session.writeRows(rows)
  const { outcome: _outcome, ...version } = await session.commit()
  return version
}

function pinned(version: DatasetVersion): PinnedDatasetVersion {
  return {
    datasetId: version.datasetId,
    versionId: version.versionId,
    createdAt: version.createdAt.toISOString(),
  }
}

async function* iterate(entries: readonly ProjectionSourceEntry[]) {
  yield* entries
}

function versionRef(version: DatasetVersion) {
  return { datasetId: version.datasetId, versionId: version.versionId }
}

const origin = (column: string) => ({ datasetId: rawDevices.id, column })

/** The edit commits made at one instant, by id, from the commit ledger. */
async function editCommitIds(plant: Plant, committedAt: string) {
  const { commits } = await plant.host.storage.ontology.commits.list({ projectId, committedAt })
  return commits.filter((commit) => commit.intent.kind === "edit").map((commit) => commit.id)
}

describe("object lineage", () => {
  test("explains projected values down to the raw columns they come from", async () => {
    const plant = await deploy()
    const { normalized, runId } = await seed(plant)

    const lineage = await plant.trusted.objects(Device).lineage("d1")

    expect(lineage).toEqual({
      objectTypeId: Device.id,
      primaryId: "d1",
      existence: { source: "projection:devices" },
      sources: {
        "projection:devices": {
          kind: "projection",
          projectionId: "devices",
          projectionRunId: runId,
          datasetVersion: versionRef(normalized),
          rowOrigins: [],
        },
        identity: { kind: "identity" },
      },
      properties: {
        id: { source: "identity" },
        name: { source: "projection:devices", column: "name", origins: [origin("device_name")] },
        note: { source: "projection:devices", column: "note", origins: [origin("note")] },
        status: { source: "projection:devices", column: "status", origins: [origin("status")] },
        serial: { source: "projection:devices", column: "serial", origins: [origin("serial")] },
      },
      restricted: 0,
    })
    // In the object type's order, for a reader to render as it is.
    expect(Object.keys(lineage?.properties ?? {})).toEqual([
      "id",
      "name",
      "note",
      "status",
      "serial",
    ])
  })

  // Guard proofs, in `lineage/projections.ts`: drop `rowOrigins` in `describeProjection`, and both
  // rows lose them; add `lineage.rows` to `visibleOrigins`, and they show under each property;
  // keep them unfiltered by `visibleRefs`, and the analyst sees the raw export's.
  test.each([
    [
      "a filter on the raw status",
      { rows: [origin("status")], columns: { ...normalizedLineage.columns, name: [] } },
      { name: [], serial: [origin("serial")] },
    ],
    // A code step records everything it reads as deciding its rows, and no column as flowing.
    [
      "a code step",
      {
        rows: [origin("device_id"), origin("serial")],
        columns: Object.fromEntries(
          Object.keys(normalizedLineage.columns).map((name) => [name, []])
        ),
      },
      { name: [], serial: [] },
    ],
  ] as const)("describes the columns that decide which rows exist once, for %s", async (_, recorded, origins) => {
    const plant = await deploy()
    await seed(plant, T0, recorded)

    const lineage = await plant.trusted.objects(Device).lineage("d1")

    expect(lineage?.sources["projection:devices"]).toMatchObject({ rowOrigins: recorded.rows })
    expect(lineage?.properties.name?.origins).toEqual(origins.name)
    expect(lineage?.properties.serial?.origins).toEqual(origins.serial)

    // Analysts may not view the raw export: its columns are left out, and counted.
    const analyst = await plant.readerIn([analysts.id]).objects(Device).lineage("d1")
    expect(analyst?.sources["projection:devices"]).toMatchObject({ rowOrigins: [] })
    expect(analyst?.restricted).toBe(1)
  })

  test("names the Action, its requester and the source value an edit replaced", async () => {
    const plant = await deploy()
    const { normalized } = await seed(plant)

    setSystemTime(new Date(T1))
    const run = await plant.readerIn(["operators"]).actions.request({
      actionId: rename.id,
      subject: device("d1"),
      params: { name: "Main pump" },
    })
    const [commitId] = await editCommitIds(plant, T1)

    const lineage = await plant.trusted.objects(Device).lineage("d1")

    expect(lineage?.properties.name).toEqual({
      source: `commit:${commitId}`,
      replaced: { source: "projection:devices", column: "name", value: "Pump" },
      resolution: { strategy: "editsWin" },
    })
    expect(lineage?.sources[`commit:${commitId}`]).toEqual({
      kind: "edit",
      commitId,
      committedAt: T1,
      requestedBy: operator,
      executor: { type: "primitive", kind: "action", id: rename.id, runId: run.id },
      action: { actionId: rename.id, runId: run.id },
    })
    expect(lineage?.sources["projection:devices"]).toMatchObject({
      datasetVersion: versionRef(normalized),
    })
  })

  test("reports the edit a newer source row won over, with both times", async () => {
    const plant = await deploy("mostRecent")
    await seed(plant)

    setSystemTime(new Date(T1))
    await plant.readerIn(["operators"]).actions.request({
      actionId: rename.id,
      subject: device("d1"),
      params: { name: "Main pump" },
    })
    const [commitId] = await editCommitIds(plant, T1)

    // The export changes the pump at T2, after the edit: its row wins again.
    await seed(plant, T2)
    const lineage = await plant.trusted.objects(Device).lineage("d1")

    expect(lineage?.properties.name).toEqual({
      source: "projection:devices",
      column: "name",
      origins: [origin("device_name")],
      replaced: { source: `commit:${commitId}`, value: "Main pump" },
      resolution: { strategy: "mostRecent", sourceUpdatedAt: T2, editedAt: T1 },
    })
    expect(lineage?.sources[`commit:${commitId}`]).toMatchObject({ kind: "edit", commitId })
  })

  test("explains a property an edit cleared", async () => {
    const plant = await deploy()
    await seed(plant)

    setSystemTime(new Date(T1))
    await plant
      .readerIn(["operators"])
      .actions.request({ actionId: clearNote.id, subject: device("d1") })
    const [commitId] = await editCommitIds(plant, T1)

    const lineage = await plant.trusted.objects(Device).lineage("d1")

    expect(lineage?.properties.note).toEqual({
      source: `commit:${commitId}`,
      removed: true,
      replaced: { source: "projection:devices", column: "note", value: "Primary" },
      resolution: { strategy: "editsWin" },
    })
  })

  test("names the projection that appended the latest telemetry point", async () => {
    const plant = await deploy()
    await seed(plant)

    setSystemTime(new Date(T1))
    const version = await commit(plant.lake, readings, [
      { device_id: "d1", at: T0, temperature: 21.5 },
    ])
    const appended = await plant.appendReadings(version, [
      {
        series: { object: { objectTypeId: Device.id, primaryId: "d1" }, propertyId: "temperature" },
        value: 21.5,
        at: T0,
      },
    ])

    const lineage = await plant.trusted.objects(Device).lineage("d1")

    expect(lineage?.properties.temperature).toEqual({
      source: `telemetry:${appended.commitId}`,
      at: T0,
    })
    expect(lineage?.sources[`telemetry:${appended.commitId}`]).toMatchObject({
      kind: "telemetry",
      commitId: appended.commitId,
      committedAt: T1,
      projectionId: readingsProjection.id,
      executor: { type: "primitive", kind: "projection", id: readingsProjection.id },
    })
  })

  // Guard proof: in `editCommitFor` (`lineage/commits.ts`), match any change of the object
  // instead of its creation, and the existence is unknown: both commits changed d9.
  test("cites the commit that created an object no projection holds", async () => {
    const plant = await deploy()
    await seed(plant)

    // An Action creates d9, and a direct write sets its note, in the same instant.
    setSystemTime(new Date(T1))
    const run = await plant
      .readerIn(["operators"])
      .actions.request({ actionId: register.id, params: { id: "d9" } })
    const [created] = await editCommitIds(plant, T1)
    await plant.trusted.objects(Device).upsert({ properties: { id: "d9", note: "Spare" } })
    const noted = (await editCommitIds(plant, T1)).find((commitId) => commitId !== created)

    const lineage = await plant.trusted.objects(Device).lineage("d9")

    expect(lineage?.existence).toEqual({ source: `commit:${created}` })
    expect(lineage?.properties).toEqual({
      id: { source: "identity" },
      name: { source: `commit:${created}` },
      note: { source: `commit:${noted}` },
      status: { source: `commit:${created}` },
    })
    expect(lineage?.sources[`commit:${created}`]).toMatchObject({
      action: { actionId: register.id, runId: run.id },
      requestedBy: operator,
    })
  })

  // Guard proof: in `editCommitFor` (`lineage/commits.ts`), match any change of the object
  // instead of one that holds the property, and the note is credited to the rename.
  test("tells apart the edit commits made at one instant", async () => {
    const plant = await deploy()
    await seed(plant)
    const devicesSdk = plant.trusted.objects(Device)

    // At T1, three direct writes: one renames d2; on d1, one sets the note it already has and
    // one renames it.
    setSystemTime(new Date(T1))
    await devicesSdk.upsert({ properties: { id: "d2", name: "Valve B" } })
    await devicesSdk.upsert({ properties: { id: "d1", note: "Primary" } })
    await devicesSdk.upsert({ properties: { id: "d1", name: "Pump B" } })

    // At T2, a write that changes nothing, alone.
    setSystemTime(new Date(T2))
    await devicesSdk.upsert({ properties: { id: "d1", status: "active" } })

    const { commits } = await plant.host.storage.ontology.commits.list({
      projectId,
      committedAt: T1,
    })
    const renamedD1 = commits.find(
      (commit) =>
        commit.result.kind === "edit" &&
        commit.result.changes.objects.some(
          (change) => change.ref.primaryId === "d1" && "name" in change.propertyChanges
        )
    )
    const [onlyAtT2] = await editCommitIds(plant, T2)
    expect(await editCommitIds(plant, T1)).toHaveLength(3)

    const lineage = await devicesSdk.lineage("d1")

    expect(lineage?.properties.name?.source).toBe(`commit:${renamedD1?.id}`)
    expect(lineage?.properties.note?.source).toBe(`commit@${T1}`)
    expect(lineage?.sources[`commit@${T1}`]).toEqual({
      kind: "edit",
      commitId: null,
      committedAt: T1,
    })
    expect(lineage?.properties.status?.source).toBe(`commit:${onlyAtT2}`)
  })

  // Guard proof: in `editLookup` (`lineage/object.ts`), name the override's `lastCommitId` for a
  // property without an edit time, and the rename is cited as certain.
  test("leaves unknown the commit of an edit recorded without its time", async () => {
    const plant = await deploy()
    await seed(plant)

    setSystemTime(new Date(T1))
    await plant.trusted.objects(Device).upsert({ properties: { id: "d1", name: "Pump B" } })

    // Overrides written before Sixb recorded edit times have none. Their last commit wrote the
    // override, not necessarily this property.
    const materializations = plant.host.storage.ontology.materializations
    const readState = materializations.readState.bind(materializations)
    materializations.readState = async (input) => {
      const state = await readState(input)
      return {
        ...state,
        objects: state.objects.map(({ override, ...object }) => ({
          ...object,
          override: override && { ...override, editedAt: undefined },
        })),
      }
    }

    const lineage = await plant.trusted.objects(Device).lineage("d1")

    expect(lineage?.properties.name?.source).toBe(`commit@${T1}`)
    expect(lineage?.sources[`commit@${T1}`]).toEqual({
      kind: "edit",
      commitId: null,
      committedAt: T1,
    })
  })
})

describe("link lineage", () => {
  const linkOf = (linkId: string, sourceId: string, targetId: string) => ({
    sourceId,
    linkId,
    targetTypeId: Device.id,
    targetId,
  })

  test("explains a link a foreign key column projects", async () => {
    const plant = await deploy()
    const { normalized, runId } = await seed(plant)

    const lineage = await plant.trusted.objects(Device).linkLineage(linkOf("parent", "d1", "d2"))

    expect(lineage).toEqual({
      sourceTypeId: Device.id,
      sourceId: "d1",
      linkId: "parent",
      targetTypeId: Device.id,
      targetId: "d2",
      existence: {
        source: "projection:devices",
        columns: ["parent_id"],
        origins: [origin("parent_id")],
      },
      sources: {
        "projection:devices": {
          kind: "projection",
          projectionId: "devices",
          projectionRunId: runId,
          datasetVersion: versionRef(normalized),
          rowOrigins: [],
        },
      },
      restricted: 0,
    })
  })

  test("explains a link a link projection projects", async () => {
    const plant = await deploy()
    await seed(plant)
    const version = await commit(plant.lake, devicePeers, [{ device_id: "d1", peer_id: "d2" }])
    const ref = {
      source: { objectTypeId: Device.id, primaryId: "d1" },
      linkId: "peers",
      target: { objectTypeId: Device.id, primaryId: "d2" },
    }
    await plant.apply(peersProjection.id, version, [
      { root: { kind: "link", ref }, assertions: [{ kind: "link", ref }] },
    ])

    const lineage = await plant.trusted.objects(Device).linkLineage(linkOf("peers", "d1", "d2"))

    // A sync writes `device_peers`: nothing upstream flows into its columns.
    expect(lineage?.existence).toEqual({
      source: "projection:device-peers",
      columns: ["device_id", "peer_id"],
      origins: [],
    })
  })

  test.each([
    ["an edge override", "peers", "d1"],
    ["a slot override", "parent", "d2"],
  ])("cites the commit of %s", async (_, linkId, sourceId) => {
    const plant = await deploy()
    await seed(plant)

    setSystemTime(new Date(T1))
    await plant.trusted.objects(Device).upsertLink(linkOf(linkId, sourceId, "d3"))
    const [commitId] = await editCommitIds(plant, T1)

    const lineage = await plant.trusted.objects(Device).linkLineage(linkOf(linkId, sourceId, "d3"))

    expect(lineage?.existence).toEqual({ source: `commit:${commitId}` })
    expect(lineage?.sources[`commit:${commitId}`]).toMatchObject({ kind: "edit", committedAt: T1 })
  })

  test("is null for a link that does not exist", async () => {
    const plant = await deploy()
    await seed(plant)

    expect(await plant.trusted.objects(Device).linkLineage(linkOf("parent", "d1", "d3"))).toBeNull()
  })
})

describe("lineage authorization", () => {
  /** d1 as operators left it: renamed through an Action. */
  async function renamed() {
    const plant = await deploy()
    const seeded = await seed(plant)

    setSystemTime(new Date(T1))
    const run = await plant.readerIn(["operators"]).actions.request({
      actionId: rename.id,
      subject: device("d1"),
      params: { name: "Main pump" },
    })
    const [commitId] = await editCommitIds(plant, T1)

    return { plant, ...seeded, run, commitKey: `commit:${commitId}` }
  }

  // Each row sees one step less: `serial` needs the clearance, the Action run `apply:action`, the
  // dataset version and its columns `view:dataset`, the raw columns `view:dataset` on the raw
  // export, and the projection's run a whole view of devices.
  //
  // Guard proofs, all in `lineage/`: filter nothing by `redacted` (`object.ts`) and analysts see
  // `serial`; return true from `canViewActionRun` (`executors.ts`) and they see the Action;
  // return every origin from `visibleOrigins` (`projections.ts`) and they see the raw columns;
  // ignore `canViewDataset` for the version (`projections.ts`) and viewers see it; return true
  // from `canViewRun` (`reader.ts`) and watchers see the projection's run.
  test.each([
    ["an operator", operators, ["clearance", "actionRun", "dataset", "raw", "projectionRun"], 0],
    ["an analyst", analysts, ["dataset", "projectionRun"], 2],
    ["a viewer", viewers, ["projectionRun"], 2],
    ["a watcher", watchers, ["clearance", "dataset", "raw"], 2],
  ] as const)("shows %s what it may see", async (_, group, visible, restricted) => {
    const { plant, normalized, runId, run, commitKey } = await renamed()
    const shows = (step: (typeof visible)[number]) => (visible as readonly string[]).includes(step)

    const lineage = await plant.readerIn([group.id]).objects(Device).lineage("d1")

    expect(lineage?.restricted).toBe(restricted)
    expect(Object.keys(lineage?.properties ?? {})).toEqual(
      shows("clearance")
        ? ["id", "name", "note", "status", "serial"]
        : ["id", "name", "note", "status"]
    )
    expect(lineage?.sources[commitKey]).toEqual({
      kind: "edit",
      commitId: commitKey.slice("commit:".length),
      committedAt: T1,
      requestedBy: operator,
      ...(shows("actionRun")
        ? {
            executor: { type: "primitive", kind: "action", id: rename.id, runId: run.id },
            action: { actionId: rename.id, runId: run.id },
          }
        : {}),
    })
    expect(lineage?.sources["projection:devices"]).toEqual({
      kind: "projection",
      projectionId: "devices",
      ...(shows("projectionRun") ? { projectionRunId: runId } : {}),
      ...(shows("dataset") ? { datasetVersion: versionRef(normalized), rowOrigins: [] } : {}),
    })
    expect(lineage?.properties.status).toEqual({
      source: "projection:devices",
      ...(shows("dataset")
        ? { column: "status", origins: shows("raw") ? [origin("status")] : [] }
        : {}),
    })
  })

  /** A shared link to d1 and the devices it lists as peers, which sees no runs. */
  function sharedLink(plant: Plant) {
    const device = { objectTypeId: Device.id, propertyIds: ["id", "name"] }
    return plant.host.withScope(
      createSharedTestScope({
        projectId,
        requestId: "shared-request",
        correlationId: "shared-correlation",
        access: {
          grants: [
            {
              kind: "object.view",
              selection: {
                kind: "selected",
                roots: [
                  {
                    anchor: { objectTypeId: Device.id, primaryId: "d1" },
                    node: {
                      objects: [device],
                      links: [
                        {
                          definitions: [
                            {
                              sourceObjectTypeId: Device.id,
                              linkId: "peers",
                              targetObjectTypeIds: [Device.id],
                              propertyIds: [],
                            },
                          ],
                          target: { objects: [device], links: [] },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
        delegation: { kind: "share", grantId: "share-grant", sessionId: "share-session" },
      })
    )
  }

  test("is null for a reader who cannot read the object", async () => {
    const { plant } = await renamed()
    const shared = sharedLink(plant)
    expect(await shared.objects(Device).get("d1")).not.toBeNull()

    // Guard proofs: in `LineageReader.for` (`lineage/reader.ts`), return a reader for delegated
    // authority, and the shared link reads d1's lineage; in `explainObject` (`lineage/object.ts`),
    // skip `readObjects`, and the watcher reads the retired d3's.
    expect(await plant.readerIn([]).objects(Device).lineage("d1")).toBeNull()
    expect(await plant.readerIn(["watchers"]).objects(Device).lineage("d3")).toBeNull()
    expect(await shared.objects(Device).lineage("d1")).toBeNull()
    expect(await plant.trusted.objects(Device).lineage("missing")).toBeNull()
  })

  test("a link's lineage is null for a reader who cannot read both of its objects", async () => {
    const plant = await deploy()
    await seed(plant)
    const toRetired = { sourceId: "d1", linkId: "peers", targetTypeId: Device.id, targetId: "d3" }
    await plant.trusted.objects(Device).upsertLink(toRetired)
    const shared = sharedLink(plant)
    expect(await shared.objects(Device).byId("d1").listLinks(Device.l.peers)).toHaveLength(1)

    // Guard proofs: in `explainLink` (`lineage/link.ts`), skip `readObjects`, and the watcher
    // reads the link to the retired d3; return a reader for delegated authority in
    // `LineageReader.for`, and the shared link reads it.
    expect(await plant.readerIn(["viewers"]).objects(Device).linkLineage(toRetired)).not.toBeNull()
    expect(await plant.readerIn([]).objects(Device).linkLineage(toRetired)).toBeNull()
    expect(await plant.readerIn(["watchers"]).objects(Device).linkLineage(toRetired)).toBeNull()
    expect(await shared.objects(Device).linkLineage(toRetired)).toBeNull()
  })

  // Guard proof: in `attributeCommits` (`lineage/commits.ts`), show every executor, and the
  // watcher sees the telemetry projection's run, the analyst the Action's.
  test.each([
    ["a telemetry projection", "projection", operators, true],
    ["a telemetry projection", "projection", watchers, false],
    ["an Action's writeback", "writeback", operators, true],
    ["an Action's writeback", "writeback", analysts, false],
  ] as const)("names %s as the executor only to a reader who may view its run (%#)", async (_, writer, group, shown) => {
    const plant = await deploy()
    await seed(plant)
    const executor = await appendTemperature(plant, writer)

    const lineage = await plant.readerIn([group.id]).objects(Device).lineage("d1")
    const telemetry = lineage?.sources[lineage.properties.temperature?.source ?? ""]

    expect(telemetry).toMatchObject({ kind: "telemetry" })
    if (shown) expect(telemetry).toHaveProperty("executor", executor)
    else expect(JSON.stringify(lineage)).not.toContain(executor.runId)
  })

  /** Append d1's temperature at T1, through the telemetry projection or an Action's writeback. */
  async function appendTemperature(
    plant: Plant,
    writer: "projection" | "writeback"
  ): Promise<Extract<EventExecutor, { readonly type: "primitive" }>> {
    setSystemTime(new Date(T1))

    if (writer === "writeback") {
      const run = await plant
        .readerIn(["operators"])
        .actions.request({ actionId: readTemperature.id, subject: device("d1") })
      return { type: "primitive", kind: "action", id: readTemperature.id, runId: run.id }
    }

    const version = await commit(plant.lake, readings, [
      { device_id: "d1", at: T0, temperature: 21.5 },
    ])
    const series = {
      object: { objectTypeId: Device.id, primaryId: "d1" },
      propertyId: "temperature",
    }
    await plant.appendReadings(version, [{ series, value: 21.5, at: T0 }])

    const runId = `run-${readingsProjection.id}-${version.versionId}`
    return { type: "primitive", kind: "projection", id: readingsProjection.id, runId }
  }
})
