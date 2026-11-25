import { expect, test } from "bun:test"
import {
  can,
  col,
  type DatasetRow,
  defineDataset,
  defineGroup,
  defineObjectType,
  defineProjection,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  link,
  type OntologyRegistry,
  prop,
  resolveAuthorizationContext,
  SixbHost,
} from "@sixb/core"
import { bindDurablePrimitiveExecution } from "@sixb/core/internal/primitive-execution"
import {
  createProjectionRunId,
  getProjectionRegistry,
  projectionTargetOf,
  shareProjectionRegistry,
} from "@sixb/core/internal/projections"
import { registerOntologyMutationRuntime } from "@sixb/core/internal/runtime"
import { shareDatasetVersionMarkings } from "@sixb/core/internal/security"
import {
  exportSnapshot,
  hostSnapshotSource,
  importSnapshot,
  type SnapshotImportReport,
} from "@sixb/core/internal/snapshots"
import type {
  DatasetChanges,
  LakeForks,
  ReadDatasetChangesInput,
  ReadDatasetRowsInput,
} from "@sixb/core/lake-storage"
import { createTestSixb, queueTestProjectionRun } from "@sixb/core/testing"
import { createTestingScope } from "../../core/src/execution/scopes"
import { runProjectionJob } from "../src/run-projection-job"

// A branch takes a projection-fed type over as its projection's source: the projection then
// continues on the branch from the version production applied, and a new version of its dataset
// updates the objects it changes, nothing else.

const Device = defineObjectType({
  id: "BranchDevice",
  name: "Device",
  properties: [prop("id", "string", { primary: true, required: true }), prop("name", "string")],
  links: [link.self("parent", { cardinality: "one" })],
})
const devices = defineDataset("branch_devices", {
  schema: [col("id", "string"), col("name", "string"), col("parent", "string", { nullable: true })],
})
const projection = defineProjection("branch_devices", Device)
  .fromDataset(devices)
  .properties({ id: "id", name: "name" })
  .withLinks({ parent: { link: Device.l.parent, sourceField: "parent", target: Device } })
const fleet = defineGroup("fleet")
const viewers = defineGroup("viewers")
const roles = [
  defineRole("fleet", { grantedTo: [fleet], grants: [can.view(Device), can.view(devices)] }),
  defineRole("viewers", { grantedTo: [viewers], grants: [can.view(Device)] }),
]

/** Production's lake, which the branch reads in place: here the same lake, slices recorded. */
class Lake extends InMemoryLakeStorage {
  fullReads = 0
  deltaReads = 0
  override readRows(input: ReadDatasetRowsInput) {
    this.fullReads++
    return super.readRows(input)
  }
  override async readChanges(input: ReadDatasetChangesInput): Promise<DatasetChanges | null> {
    this.deltaReads++
    return super.readChanges(input)
  }
  readonly forks: LakeForks = {
    currentPoint: async () => "point",
    versionsAt: async ({ datasetIds }) =>
      new Map(
        await Promise.all(
          datasetIds.map(async (id) => [id, await this.getLatestVersion(id)] as const)
        )
      ),
    writeSlice: async (input) => {
      const files = new Set(input.versions.map((version) => version.versionId))
      await input.record(files)
      return files
    },
    openFile: async () => null,
    releaseFiles: async () => 0,
  }
}

function hostOn(storage: InMemoryStorage, lake: Lake) {
  return new SixbHost({
    id: "branch-projection",
    ontology: [Device],
    datasets: [devices],
    projections: [projection],
    groups: [fleet, viewers],
    roles,
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
    lakeStorage: lake,
    storage,
  })
}

async function write(lake: Lake, rows: readonly DatasetRow[]) {
  await lake.createDataset(devices)
  const latest = await lake.getLatestVersion(devices.id)
  while (latest && Date.now() <= latest.createdAt.getTime()) await Bun.sleep(1)
  const writer = await lake.beginWrite({ dataset: devices, mode: "snapshot" })
  await writer.writeRows(rows)
  return writer.commit({ commitMessage: "devices" })
}

/** One projection run of a version, as the projection worker runs it. */
async function project(host: SixbHost, storage: InMemoryStorage, lake: Lake, versionId: string) {
  const version = await lake.getVersion(devices.id, versionId)
  if (!version) throw new Error("Missing version")
  const { datasetId, ...dispatch } = getProjectionRegistry(host).resolveDispatch(projection.id)
  const identity = {
    ...dispatch,
    datasetVersion: { datasetId, versionId, createdAt: version.createdAt.toISOString() },
  }
  if (identity.projectionKind !== "object") throw new Error("Unexpected projection kind")

  const id = createProjectionRunId(host.id, identity)
  const target = projectionTargetOf(projection)
  if (!("objectTypeId" in target)) throw new Error("Unexpected projection target")
  await queueTestProjectionRun(storage, { projectId: host.id, id, identity, target })
  const run = await storage.projectionRuns.getById({ projectId: host.id, id })
  const execution = await storage.executions.getById({ projectId: host.id, id: run!.executionId })
  const bound = bindDurablePrimitiveExecution(host, {
    execution: execution!,
    primitive: { kind: "projection", id: projection.id, runId: id },
  })
  const runtime = {
    projectId: host.id,
    ontology: host.definitions.ontology,
    lakeStorage: lake,
    projectionRunsStorage: storage.projectionRuns,
    syncRuns: storage.syncRuns,
    datasets: host.definitions.datasets,
    projections: host.definitions.projections,
  }
  shareProjectionRegistry(host, runtime)
  shareDatasetVersionMarkings(host, runtime)
  registerOntologyMutationRuntime(runtime, bound.ontologyMutations)
  return runProjectionJob({ runtime, job: { id, ...identity } })
}

/** What the last projection commit changed. */
async function projectionCommitCounts(storage: InMemoryStorage, projectId: string) {
  const { commits } = await storage.ontology.commits.list({ projectId, limit: 100 })
  const last = [...commits].reverse().find((commit) => commit.result.kind === "projection")
  return last?.result.kind === "projection" ? last.result.counts : undefined
}

const rows = (count: number, name = (index: number) => `device ${index}`) =>
  Array.from({ length: count }, (_, index) => ({
    id: `d-${index}`,
    name: name(index),
    parent: index === 0 ? null : "d-0",
  }))

async function production() {
  const lake = new Lake()
  const storage = new InMemoryStorage()
  const host = hostOn(storage, lake)
  const applied = await write(lake, rows(100))
  await project(host, storage, lake, applied.versionId)

  // A person's edit over a projected object.
  await createTestSixb(host)
    .objects(Device)
    .upsert({ properties: { id: "d-7", name: "renamed by hand" } })
  return { lake, storage, host, applied }
}

async function branchOf(
  prod: Awaited<ReturnType<typeof production>>,
  scopeGroups: readonly string[] = [fleet.id]
) {
  const scope = createTestingScope({
    projectId: prod.host.id,
    context: resolveAuthorizationContext({
      principal: { type: "user", id: "usr_alice" },
      groupIds: scopeGroups,
      roles: prod.host.definitions.security.listResolvedRoles(),
    }),
  })
  const snapshot = exportSnapshot(hostSnapshotSource(prod.host), {
    scope,
    lake: { path: "/tmp/branch-projection.ducklake", branch: "fleet", onSlice: () => undefined },
  })

  const storage = (await prod.storage.createBranchNamespace("fleet")) as InMemoryStorage
  const report: SnapshotImportReport = await importSnapshot({
    snapshot,
    storage,
    ontology: prod.host.definitions.ontology as OntologyRegistry,
    projections: prod.host.definitions.projections,
  })
  return { storage, host: hostOn(storage, prod.lake), report }
}

// Red check: in snapshots/export.ts `travellingSources`, send every type as objects (return an
// empty map): the type loads as created objects, the branch's projection reads the dataset in
// full and finds every object its own, and the edit over d-7 is lost.
test("a branch's projection updates only what a new version changed", async () => {
  const prod = await production()
  const branch = await branchOf(prod)

  expect(branch.report.types).toEqual([
    expect.objectContaining({
      objectTypeId: Device.id,
      objects: 100,
      projectionId: projection.id,
      reprojectable: true,
    }),
  ])

  // A pipeline on the branch changes three devices.
  const changed = await write(
    prod.lake,
    rows(100, (index) => ([3, 7, 42].includes(index) ? `device ${index} v2` : `device ${index}`))
  )
  const fullReads = prod.lake.fullReads
  const result = await project(branch.host, branch.storage, prod.lake, changed.versionId)

  expect(result.run.status).toBe("succeeded")
  expect(result.run.progress).toMatchObject({ sourceRowsRead: 0, sourceChangesRead: 3 })
  expect(prod.lake.fullReads).toBe(fullReads)
  // d-7's edit wins over its new name: two objects change, no object is created.
  expect(await projectionCommitCounts(branch.storage, branch.host.id)).toMatchObject({
    objectsCreated: 0,
    objectsUpdated: 2,
    objectsDeleted: 0,
    linksCreated: 0,
    linksDeleted: 0,
  })

  const read = (primaryId: string) =>
    branch.storage.objects.getByPrimaryId({
      projectId: branch.host.id,
      objectTypeId: Device.id,
      primaryId,
    })
  expect((await read("d-3"))?.properties.name).toBe("device 3 v2")
  expect((await read("d-7"))?.properties.name).toBe("renamed by hand")
  expect((await read("d-8"))?.properties.name).toBe("device 8")
})

// Red check: in snapshots/export.ts `travellingSources`, drop the full-read check: a person who
// cannot read the dataset gets its source rows.
test("a type whose dataset the person cannot read in full travels as created objects", async () => {
  const prod = await production()
  const branch = await branchOf(prod, [viewers.id])

  expect(branch.report.types).toEqual([
    expect.objectContaining({
      objectTypeId: Device.id,
      objects: 100,
      reprojectable: false,
      notReprojectable: "the person does not read its dataset in full",
    }),
  ])
})
