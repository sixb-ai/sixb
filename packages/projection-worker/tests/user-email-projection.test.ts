import { expect, test } from "bun:test"
import {
  col,
  type DatasetRow,
  defineDataset,
  defineObjectType,
  defineProjection,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  ref,
  SixbHost,
  userRef,
} from "@sixb/core"
import { bindDurablePrimitiveExecution } from "@sixb/core/internal/primitive-execution"
import {
  createProjectionRunId,
  getProjectionRegistry,
  shareProjectionRegistry,
} from "@sixb/core/internal/projections"
import { registerOntologyMutationRuntime } from "@sixb/core/internal/runtime"
import { shareDatasetVersionMarkings } from "@sixb/core/internal/security"
import { queueTestProjectionRun } from "@sixb/core/testing"
import { runProjectionJob } from "../src/run-projection-job"
import type { ProjectionWorkerContext } from "../src/types"

const PROJECT_ID = "user-email-projection"

const Meeting = defineObjectType({
  id: "Meeting",
  name: "Meeting",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("title", "string"),
    prop("organizer", ref.user(), { nullable: true }),
  ],
})

const meetings = defineDataset("meetings", {
  schema: [
    col("id", "string"),
    col("title", "string"),
    col("organizer_email", "string", { nullable: true }),
  ],
})

const meetingsProjection = defineProjection("meetings", Meeting)
  .fromDataset(meetings)
  .properties({ id: "id", title: "title", organizer: userRef.fromEmail("organizer_email") })

function fixture() {
  const lake = new InMemoryLakeStorage()
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: PROJECT_ID,
    ontology: [Meeting],
    datasets: [meetings],
    projections: [meetingsProjection],
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
    lakeStorage: lake,
    storage,
  })

  const join = (id: string, email: string) =>
    storage.auth.users.create({ projectId: PROJECT_ID, id, email })

  const write = async (rows: readonly DatasetRow[]) => {
    await lake.createDataset(meetings)
    // Versions are ordered by creation time, so a second write must land on a later millisecond.
    const latest = await lake.getLatestVersion(meetings.id)
    while (latest && Date.now() <= latest.createdAt.getTime()) await Bun.sleep(1)
    const writer = await lake.beginWrite({
      dataset: meetings,
      mode: "snapshot",
      producer: { kind: "sync", id: "calendar", runId: `write-${Date.now()}` },
    })
    await writer.writeRows(rows)
    return writer.commit({ commitMessage: "calendar events" })
  }

  const run = async (
    versionId: string,
    options: { readonly users?: ProjectionWorkerContext["users"] | null } = {}
  ) => {
    const version = await lake.getVersion(meetings.id, versionId)
    if (!version) throw new Error("Missing meetings version")
    const { datasetId, ...dispatch } = getProjectionRegistry(host).resolveDispatch(
      meetingsProjection.id
    )
    const identity = {
      ...dispatch,
      datasetVersion: { datasetId, versionId, createdAt: version.createdAt.toISOString() },
    }
    if (identity.projectionKind !== "object") throw new Error("Expected an object projection")
    const id = createProjectionRunId(host.id, identity)
    await queueTestProjectionRun(storage, {
      projectId: host.id,
      id,
      identity,
      target: { objectTypeId: Meeting.id },
    })
    const run = await storage.projectionRuns.getById({ projectId: host.id, id })
    const execution = await storage.executions.getById({ projectId: host.id, id: run!.executionId })
    const bound = bindDurablePrimitiveExecution(host, {
      execution: execution!,
      primitive: { kind: "projection", id: meetingsProjection.id, runId: id },
    })
    const users = options.users === undefined ? storage.auth.users : options.users
    const runtime: ProjectionWorkerContext = {
      projectId: host.id,
      ontology: host.definitions.ontology,
      lakeStorage: lake,
      projectionRunsStorage: storage.projectionRuns,
      ...(users ? { users } : {}),
      datasets: host.definitions.datasets,
      projections: host.definitions.projections,
    }
    shareProjectionRegistry(host, runtime)
    shareDatasetVersionMarkings(host, runtime)
    registerOntologyMutationRuntime(runtime, bound.ontologyMutations)
    return runProjectionJob({ runtime, job: { id, ...identity } })
  }

  const organizer = async (primaryId: string) => {
    const meeting = await storage.objects.getByPrimaryId({
      projectId: host.id,
      objectTypeId: Meeting.id,
      primaryId,
    })
    return meeting?.properties.organizer
  }

  return { storage, join, write, run, organizer }
}

// Red proof: skip the `propertyPlan.members` branch in `collectProperties`; the run fails on the
// email column, which the userRef schema cannot hold.
test("stores the member each row's email names, ignoring case", async () => {
  const f = fixture()
  await f.join("usr_ava", "ava@acme.com")
  await f.join("usr_ben", "ben@acme.com")
  await f.storage.auth.users.updateStatus({
    projectId: PROJECT_ID,
    id: "usr_ben",
    status: "suspended",
  })

  const version = await f.write([
    { id: "m1", title: "Kickoff", organizer_email: " Ava@Acme.com " },
    { id: "m2", title: "Retro", organizer_email: "ben@acme.com" },
    { id: "m3", title: "Interview", organizer_email: "candidate@example.com" },
    { id: "m4", title: "Focus", organizer_email: null },
  ])
  const result = await f.run(version.versionId)

  expect(result.run.status).toBe("succeeded")
  expect(await f.organizer("m1")).toEqual(userRef("usr_ava"))
  // A suspended member is still the person the source names.
  expect(await f.organizer("m2")).toEqual(userRef("usr_ben"))
  expect(await f.organizer("m3")).toBeUndefined()
  expect(await f.organizer("m4")).toBeUndefined()
})

// Red proof: drop `members` from the plan in `prepareIncrementalReplacement`; the delta run fails.
test("resolves the rows a later version changes against the members at that run", async () => {
  const f = fixture()
  const first = await f.write([
    { id: "m1", title: "Kickoff", organizer_email: "cleo@acme.com" },
    { id: "m2", title: "Retro", organizer_email: "cleo@acme.com" },
  ])
  await f.run(first.versionId)
  expect(await f.organizer("m1")).toBeUndefined()

  await f.join("usr_cleo", "cleo@acme.com")
  const second = await f.write([
    { id: "m1", title: "Kickoff (moved)", organizer_email: "cleo@acme.com" },
    { id: "m2", title: "Retro", organizer_email: "cleo@acme.com" },
  ])
  const result = await f.run(second.versionId)

  expect(result.run.progress.sourceChangesRead).toBe(1)
  expect(await f.organizer("m1")).toEqual(userRef("usr_cleo"))
  // The delta run reads only changed rows; the unchanged one keeps what its own run resolved.
  expect(await f.organizer("m2")).toBeUndefined()
})

test("fails the run when the runtime has no member directory", async () => {
  const f = fixture()
  const version = await f.write([{ id: "m1", title: "Kickoff", organizer_email: "ava@acme.com" }])

  const error = await f.run(version.versionId, { users: null }).catch((caught) => caught)

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe(
    "[SixbProjectionWorker] Projection 'meetings' resolves members by email, but this runtime has no auth storage. Configure storage with auth."
  )
})
