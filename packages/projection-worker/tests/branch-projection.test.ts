import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

const Site = defineObjectType({
  id: "BranchSite",
  name: "Site",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("status", "string", { query: { searchable: true, filterable: true } }),
  ],
})
const Device = defineObjectType({
  id: "BranchDevice",
  name: "Device",
  properties: [prop("id", "string", { primary: true, required: true }), prop("name", "string")],
  // `parent` is the projection's; `site` and `peers` are edited by hand, or by a link projection.
  links: [
    link.self("parent", { cardinality: "one" }),
    link("site", Site, { cardinality: "many" }),
    link.self("peers", { cardinality: "many" }),
  ],
})
const devices = defineDataset("branch_devices", {
  schema: [col("id", "string"), col("name", "string"), col("parent", "string", { nullable: true })],
})
const projection = defineProjection("branch_devices", Device)
  .fromDataset(devices)
  .properties({ id: "id", name: "name" })
  .withLinks({ parent: { link: Device.l.parent, sourceField: "parent", target: Device } })
const peerPairs = defineDataset("branch_device_peers", {
  schema: [col("from", "string"), col("to", "string")],
})
const peers = defineProjection("branch_device_peers", Device.l.peers)
  .fromDataset(peerPairs)
  .sourceField("from")
  .targetField("to")
const fleet = defineGroup("fleet")
const viewers = defineGroup("viewers")
const oneDevice = defineGroup("one-device")
// The fleet reads open sites only: an edit linking a device to a closed one stays in production.
const roles = [
  defineRole("fleet", {
    grantedTo: [fleet],
    grants: [
      can.view(Device),
      can.view(devices),
      can.view(Site).where((site) => site.p.status.eq("open")),
    ],
  }),
  defineRole("viewers", { grantedTo: [viewers], grants: [can.view(Device)] }),
  // Reads the dataset in full, but one device only.
  defineRole("one-device", {
    grantedTo: [oneDevice],
    grants: [can.view(Device).where((device) => device.p.id.eq("d-1")), can.view(devices)],
  }),
]

let rootDir: string
let clock: number
beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "sixb-branch-projection-"))
  clock = Date.parse("2026-11-01T00:00:00.000Z")
})
afterEach(async () => {
  setSystemTime()
  await rm(rootDir, { recursive: true, force: true })
})

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

function hostOn(storage: InMemoryStorage, lake: Lake, withPeers = false) {
  return new SixbHost({
    id: "branch-projection",
    ontology: [Site, Device],
    datasets: withPeers ? [devices, peerPairs] : [devices],
    projections: withPeers ? [projection, peers] : [projection],
    groups: [fleet, viewers, oneDevice],
    roles,
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
    lakeStorage: lake,
    storage,
  })
}

/** A version of the devices, a second after the last: versions are ordered by when they land. */
async function write(lake: Lake, rows: readonly DatasetRow[]) {
  clock += 1_000
  setSystemTime(new Date(clock))
  await lake.createDataset(devices)
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

  const id = createProjectionRunId(host.id, identity, null)
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
    branch: null,
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

const device = (index: number) => ({
  id: `d-${index}`,
  name: `device ${index}`,
  parent: index === 0 ? null : "d-0",
})
const rows = (count: number) => Array.from({ length: count }, (_, index) => device(index))

async function production(withPeers = false) {
  const lake = new Lake()
  const storage = new InMemoryStorage()
  const host = hostOn(storage, lake, withPeers)
  const applied = await write(lake, rows(100))
  await project(host, storage, lake, applied.versionId)

  // People's edits over what the projection made: a name, a cleared parent, and two sites, one of
  // which the fleet cannot read.
  const trusted = createTestSixb(host)
  await trusted.objects(Site).upsert({ properties: { id: "site-open", status: "open" } })
  await trusted.objects(Site).upsert({ properties: { id: "site-closed", status: "closed" } })
  await trusted.objects(Device).upsert({ properties: { id: "d-7", name: "renamed by hand" } })
  await trusted
    .objects(Device)
    .byId("d-9")
    .unlink(Device.l.parent, { objectTypeId: Device.id, primaryId: "d-0" })
  await trusted
    .objects(Device)
    .byId("d-1")
    .link(Device.l.site, { objectTypeId: Site.id, primaryId: "site-open" })
  await trusted
    .objects(Device)
    .byId("d-2")
    .link(Device.l.site, { objectTypeId: Site.id, primaryId: "site-closed" })
  return { lake, storage, host, applied }
}

/** The ids a device links to through `linkId`, on a storage. */
async function linked(storage: InMemoryStorage, primaryId: string, linkId: string) {
  const links = await storage.objects.listLinks({
    projectId: "branch-projection",
    objectTypeId: Device.id,
    objectId: primaryId,
    linkId,
  })
  return links.map((row) => row.targetId)
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
  const frames: Uint8Array[] = []
  for await (const frame of exportSnapshot(hostSnapshotSource(prod.host), {
    scope,
    compress: false,
    lake: { path: join(rootDir, "slice.ducklake"), branch: "fleet", onSlice: () => undefined },
  })) {
    frames.push(frame)
  }

  const storage = (await prod.storage.createBranchNamespace("fleet")) as InMemoryStorage
  const report: SnapshotImportReport = await importSnapshot({
    snapshot: (async function* () {
      yield* frames
    })(),
    storage,
    ontology: prod.host.definitions.ontology as OntologyRegistry,
    projections: prod.host.definitions.projections,
  })
  const text = Buffer.concat(frames).toString("latin1")
  return { storage, host: hostOn(storage, prod.lake), report, text }
}

// Red checks: in snapshots/export.ts `travellingSources`, send every type as objects (return an
// empty map): the type loads as created objects, the branch's projection reads the dataset in
// full, and d-9's parent comes back. In `exportLinkEdits`, keep only edits whose target type is
// read without a condition, as before: d-1's site edit is lost.
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
    expect.objectContaining({ objectTypeId: Site.id, objects: 1 }),
  ])
  // The edit to a closed site leaves nothing of it; the others travel.
  expect(branch.text.includes("site-closed")).toBe(false)
  expect(await linked(branch.storage, "d-1", "site")).toEqual(["site-open"])
  expect(await linked(branch.storage, "d-2", "site")).toEqual([])
  expect(await linked(branch.storage, "d-9", "parent")).toEqual([])
  // The edits themselves travel: the site d-1 was linked to by hand, and d-9's cleared parent.
  const edits = await branch.storage.readSnapshot({ views: 1, maxDurationMs: 60_000 }, ([view]) =>
    view!.readLinkEdits({ projectId: branch.host.id, sourceTypeId: Device.id, limit: 10 })
  )
  expect(
    edits.map((edit) => (edit.kind === "edge" ? edit.ref.target.primaryId : edit.linkId))
  ).toEqual(["site-open", "parent"])

  // A pipeline on the branch renames d-1, d-3, d-7 and d-9, deletes d-5, moves d-11 and orphans
  // d-12. Renaming d-1 and d-9 touches the objects whose links people edited.
  const next = rows(100)
    .filter((row) => row.id !== "d-5")
    .map((row) => {
      if (["d-1", "d-3", "d-7", "d-9"].includes(row.id)) return { ...row, name: `${row.name} v2` }
      if (row.id === "d-11") return { ...row, parent: "d-2" }
      if (row.id === "d-12") return { ...row, parent: null }
      return row
    })
  const changed = await write(prod.lake, next)
  const fullReads = prod.lake.fullReads
  const result = await project(branch.host, branch.storage, prod.lake, changed.versionId)

  expect(result.run.status).toBe("succeeded")
  expect(result.run.progress).toMatchObject({ sourceRowsRead: 0, sourceChangesRead: 7 })
  expect(prod.lake.fullReads).toBe(fullReads)
  // d-7's edit wins over its new name, and d-9's cleared parent stays cleared: d-11's new parent
  // is the one link made, and no object is.
  expect(await projectionCommitCounts(branch.storage, branch.host.id)).toMatchObject({
    objectsCreated: 0,
    objectsUpdated: 3,
    objectsDeleted: 1,
    linksCreated: 1,
  })

  const read = (primaryId: string) =>
    branch.storage.objects.getByPrimaryId({
      projectId: branch.host.id,
      objectTypeId: Device.id,
      primaryId,
    })
  expect((await read("d-3"))?.properties.name).toBe("device 3 v2")
  expect((await read("d-7"))?.properties.name).toBe("renamed by hand")
  expect(await read("d-5")).toBeNull()
  expect(await linked(branch.storage, "d-9", "parent")).toEqual([])
  expect(await linked(branch.storage, "d-11", "parent")).toEqual(["d-2"])
  expect(await linked(branch.storage, "d-12", "parent")).toEqual([])
  expect(await linked(branch.storage, "d-1", "site")).toEqual(["site-open"])
})

// Red check: in snapshots/export.ts `travellingSources`, drop the link projections' check: the
// devices travel as their source, and the peers the link projection made lose their maker.
test("a type a link projection also feeds travels as created objects", async () => {
  const prod = await production(true)
  const branch = await branchOf(prod)

  expect(branch.report.types).toContainEqual(
    expect.objectContaining({
      objectTypeId: Device.id,
      reprojectable: false,
      notReprojectable: "a link projection feeds links from it, and its source does not travel",
    })
  )
})

// Red check: in snapshots/export.ts `travellingSources`, drop the full-read check: a person who
// cannot read the dataset gets its source rows.
test("a type whose dataset the person cannot read in full travels as created objects", async () => {
  const prod = await production()
  const branch = await branchOf(prod, [viewers.id])

  expect(branch.report.types).toContainEqual(
    expect.objectContaining({
      objectTypeId: Device.id,
      objects: 100,
      reprojectable: false,
      notReprojectable: "the person does not read its dataset in full",
    })
  )
})

// Red check: in snapshots/export.ts `travellingSources`, drop the condition and hidden properties
// check: the devices travel as their source, and the edit of d-7, which the person does not see,
// leaves production with it.
test("a type the person reads through a condition travels as created objects", async () => {
  const prod = await production()
  const branch = await branchOf(prod, [oneDevice.id])

  expect(branch.report.types).toContainEqual(
    expect.objectContaining({
      objectTypeId: Device.id,
      objects: 1,
      reprojectable: false,
      notReprojectable: "the person does not read every object and property of the type",
    })
  )
  expect(branch.text).not.toContain("renamed by hand")
})
