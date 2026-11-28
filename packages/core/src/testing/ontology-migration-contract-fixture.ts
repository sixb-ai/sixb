import {
  col,
  type DatasetDefinition,
  defineDataset,
  defineMigration,
  defineObjectType,
  defineProjection,
  type EmbeddingModel,
  link,
  type ObjectTypeWithPropertyTokens,
  OntologyRegistry,
  prop,
  ref,
  SixbHost,
  type Storage,
} from ".."
import { InMemoryBlobStorage } from "../blob-storage"
import { InMemoryBroker } from "../broker"
import { restoreTrustedPrimitiveExecutionScope } from "../execution/durable"
import { createTestingScope } from "../execution/scopes"
import type { JsonValue } from "../json"
import { InMemoryLakeStorage } from "../lake-storage"
import type { ProjectionExecution } from "../materialization/model"
import {
  createOntologyMaterializer,
  type OntologyEditOperation,
  ProjectionRegistry,
  type ProjectionSourceEntry,
} from "../materializer"
import { InMemoryQueues } from "../queues"
import { migrateStorage } from "../storage/migrations"
import { createTestSixb } from "./execution"
import { startTestProjectionRun } from "./projection-execution"
import { createStoredArtifact } from "./stored-artifacts"

// Jobs as a first release stores them, in every place a property can live, then the releases that
// remove `gate` and `contract`, or rename them and remove the links. Edit-created jobs hold values,
// a vector, an artifact, a unique value and links; projected jobs hold source rows and source
// links, a losing edit, an unset, a cleared lead, absent values and a row a delete hides; an
// inspection, a subtype, inherits it all. Every release keeps a projected `depot`, whose source
// links sit beside the removed `lead`'s.

export const PROJECT = "ontology-migration-contract"
export const ARTIFACT = "art_m1g2r3t4n5"
/** A SQL provider creates schemas and builds indexes for each case. */
export const TIMEOUT_MS = 30_000

const AT = "2026-04-01T00:00:00.000Z"

const embedding: EmbeddingModel = {
  providerId: "test",
  modelId: "migration-text",
  definition: { kind: "embedding", providerId: "test", modelId: "migration-text", dimensions: 2 },
  async embed({ texts }) {
    return { vectors: texts.map((text) => [1, text.length]) }
  },
}

const Technician = defineObjectType({
  id: "MigrationTechnician",
  name: "Technician",
  properties: [prop("id", "string", { primary: true, required: true })],
})

export interface ReleaseOptions {
  /** The id `gate` has in the release, or `null` once removed. */
  readonly gate: "gate" | "gateCode" | null
  readonly contract: "contract" | "agreement" | null
  /** Whether jobs have a `crew` and a `lead`; every release has a `depot`. */
  readonly links: boolean
  readonly uniqueGate?: boolean
  readonly uniqueNote?: boolean
}

/** A release of jobs: the first stores `gate`, `contract` and links; later ones move them. */
export function release(options: ReleaseOptions) {
  const { gate, contract } = options
  const Job = defineObjectType({
    id: "MigrationJob",
    name: "Job",
    properties: [
      prop("id", "string", { primary: true, required: true }),
      ...(gate
        ? [
            prop(gate, "string", {
              ...(options.uniqueGate === false ? {} : { unique: true as const }),
              nullable: true,
              query: { searchable: true, filterable: true, sortable: true },
            }),
          ]
        : []),
      ...(contract ? [prop(contract, ref.artifact(), { nullable: true })] : []),
      prop("note", "string", {
        ...(options.uniqueNote ? { unique: true as const } : {}),
        query: { searchable: true, text: true },
      }),
      prop("temperature", "double", { mode: "telemetry" }),
    ],
    links: [
      link("depot", Technician, { cardinality: "one" }),
      ...(options.links
        ? [
            link("crew", Technician, { cardinality: "many" }),
            link("lead", Technician, { cardinality: "one" }),
          ]
        : []),
    ],
    search: {
      vectors: {
        ...(gate ? { gates: { source: [gate], model: embedding } } : {}),
        notes: { source: ["note"], model: embedding },
      },
    },
    // A text count filtered on the key: its columns are named after the definition only.
    ...(gate
      ? { query: { indexes: [{ kind: "text", propertyId: "note", filters: [gate] }] } }
      : {}),
  })
  const Inspection = defineObjectType({
    id: "MigrationInspection",
    name: "Inspection",
    extends: Job,
    properties: [],
  })

  const ontology = new OntologyRegistry({ sources: [Technician, Job, Inspection] })
  const jobs = defineDataset("migration_contract_jobs", {
    schema: [
      col("id", "string"),
      col("gate", "string", { nullable: true }),
      col("lead_id", "string", { nullable: true }),
      col("depot_id", "string", { nullable: true }),
      col("updated_at", "timestamp"),
    ],
  })
  const mapped = defineProjection("migration_contract_jobs", Job)
    .fromDataset(jobs)
    .properties(gate ? ({ id: "id", [gate]: "gate" } as { id: "id" }) : { id: "id" })
  const depot = { link: Job.l.depot, sourceField: "depot_id" as const, target: Technician }
  const projection = mapped
    .withLinks(
      options.links
        ? { depot, lead: { link: Job.l.lead, sourceField: "lead_id", target: Technician } }
        : { depot }
    )
    .resolveConflicts({ strategy: "mostRecent", sourceTimestamp: "updated_at" })
  const projections = new ProjectionRegistry({
    projections: [projection],
    ontology,
    datasetsById: new Map<string, DatasetDefinition>([[jobs.id, jobs]]),
  })

  return { Job, Inspection, ontology, projections, projection, jobs }
}

export const v1 = release({ gate: "gate", contract: "contract", links: true })
export const v2 = release({ gate: null, contract: null, links: true })
/** The release that renames `gate` and `contract`, and no longer links jobs to technicians. */
export const renamed = release({ gate: "gateCode", contract: "agreement", links: false })

/** Removes both properties `v2` dropped. */
export const removeGate = defineMigration("job-gate", v2.Job)
  .removeProperty("gate")
  .removeProperty("contract")

/** Renames both properties, and removes both links, as `renamed` needs. */
export const renameGate = defineMigration("job-gate-code", renamed.Job)
  .renameProperty("gate", "gateCode")
  .renameProperty("contract", "agreement")
  .removeLink("crew")
  .removeLink("lead")

/**
 * Jobs with one optional string property per name and no projection: a migration that removes or
 * renames every one compiles into long expressions in each store's statement.
 */
export function wideRelease(names: readonly string[]) {
  const Job = defineObjectType({
    id: "MigrationWideJob",
    name: "Wide job",
    properties: [
      prop("id", "string", { primary: true, required: true }),
      ...names.map((name) => prop(name, "string", { nullable: true })),
    ],
  })
  const Inspection = defineObjectType({
    id: "MigrationWideInspection",
    name: "Wide inspection",
    extends: Job,
    properties: [],
  })
  return {
    Job,
    Inspection,
    ontology: new OntologyRegistry({ sources: [Technician, Job, Inspection] }),
  }
}

export const JOB = v1.Job.id
export const INSPECTION = v1.Inspection.id
export const TECHNICIAN = Technician.id

/** Jobs that hold `gate` in every store, and `j-note`, which holds neither removed property. */
export async function seedJobs(storage: Storage): Promise<void> {
  await migrateStorage(storage, {
    projectId: PROJECT,
    ontology: v1.ontology,
    ontologyShapes: "deploy",
  })
  await createStoredArtifact(storage, { projectId: PROJECT, id: ARTIFACT })

  const sixb = firstRelease(storage)

  await sixb.objects(v1.Job).upsert({
    properties: {
      id: "j-1",
      gate: "A1",
      note: "first",
      contract: { type: "artifact", id: ARTIFACT },
    },
  })
  await sixb.objects(v1.Job).byId("j-1").vector("gates").index()
  await sixb.objects(v1.Job).byId("j-1").vector("notes").index()
  await sixb
    .objects(v1.Job)
    .byId("j-1")
    .telemetry(v1.Job.p.temperature)
    .append({ value: 21.5, at: new Date(AT) })
  await sixb.objects(v1.Job).upsert({ properties: { id: "j-note", note: "nothing to remove" } })
  for (const id of ["j-2", "j-3", "j-4", "j-5"]) {
    await sixb.objects(v1.Job).upsert({ properties: { id, gate: `G-${id}` } })
  }
  await sixb.objects(v1.Inspection).upsert({ properties: { id: "i-1", gate: "I1" } })

  // Links an action wrote: a crew edge and a lead slot.
  for (const id of ["t-1", "t-2"]) await sixb.objects(Technician).upsert({ properties: { id } })
  await sixb.objects(v1.Job).byId("j-1").link(v1.Job.l.crew, technicianRef("t-1"))
  await sixb.objects(v1.Job).byId("j-1").link(v1.Job.l.lead, technicianRef("t-2"))

  // Projected jobs: `p-1`'s edit loses to a newer source row, `p-2`'s edit clears it, `p-3`'s row
  // names it absent, and `p-4`'s row is hidden by a delete. `p-1`'s projected lead is cleared.
  await publish(
    storage,
    1,
    [
      entry("p-1", "P1", "t-1"),
      entry("p-2", "P2"),
      entry("p-3", undefined, "t-2"),
      entry("p-4", "P4"),
    ],
    at(1)
  )
  await edits(storage, at(2)).commit([
    patch("p-1", { gate: "E1" }),
    patch("p-2", {}, ["gate", "note"]),
    { id: "delete-p-4", kind: "object.delete", ref: jobRef("p-4") },
    {
      id: "clear-p-1",
      kind: "link.delete",
      ref: { source: jobRef("p-1"), linkId: "lead", target: technicianRef("t-1") },
    },
  ])
  await publish(
    storage,
    2,
    [
      entry("p-1", "P1b", "t-1"),
      entry("p-2", "P2"),
      entry("p-3", undefined, "t-2"),
      entry("p-4", "P4"),
    ],
    at(3)
  )
}

/** A release's trusted client, the first one's by default: what its actions write. */
export function firstRelease(
  storage: Storage,
  code: {
    readonly Job: ObjectTypeWithPropertyTokens
    readonly Inspection: ObjectTypeWithPropertyTokens
  } = v1
) {
  const host = new SixbHost({
    id: PROJECT,
    ontology: [Technician, code.Job, code.Inspection],
    models: { embedding: [embedding] },
    blobStorage: new InMemoryBlobStorage(),
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    queues: new InMemoryQueues(),
    storage,
  })
  hosts.set(storage, [...(hosts.get(storage) ?? []), host])
  return createTestSixb(host)
}

const hosts = new WeakMap<Storage, SixbHost[]>()

/** Stops the clients' outbox dispatch, which would otherwise outlive the storage it reads. */
export async function closeReleases(storage: Storage): Promise<void> {
  for (const host of hosts.get(storage) ?? []) await host.closeBroker()
  hosts.delete(storage)
}

/**
 * Opens the plan of a ready, empty candidate of the jobs projection, its commit timed `at`, and
 * returns the time the plan keeps: a plan opened again keeps its first one, unless it was dropped.
 */
export async function openReplacementPlan(storage: Storage, at: string): Promise<string> {
  const resolved = v1.projections.resolveSource(v1.projection.id)
  const datasetVersion = { datasetId: v1.jobs.id, versionId: "jobs-plan", createdAt: AT }
  const identity = {
    projectionId: v1.projection.id,
    datasetVersion,
    ontologyRevision: resolved.ontologyRevision,
    projectionRevision: resolved.projectionRevision,
    ownershipHash: resolved.ownershipHash,
    projectionKind: "object" as const,
    protocol: "replacement" as const,
  }
  const source = { projectionId: v1.projection.id }
  const runId = "migration-jobs-plan"

  let execution = (await storage.projectionRuns?.getById({ projectId: PROJECT, id: runId }))
    ? undefined
    : (
        await startTestProjectionRun(storage, {
          id: runId,
          projectId: PROJECT,
          identity,
          target: { objectTypeId: JOB },
        })
      ).execution
  if (execution) {
    const ready = { projectId: PROJECT, source, materializationId: "plan", execution }
    await storage.ontology.sources.beginMaterialization({
      ...ready,
      projectionKind: "object",
      protocol: "replacement",
      datasetVersion,
      projectionRevision: identity.projectionRevision,
      ownershipHash: identity.ownershipHash,
      ontologyRevision: identity.ontologyRevision,
      createdAt: AT,
    })
    await storage.ontology.sources.markReady({
      ...ready,
      rootCount: 0,
      assertionCount: 0,
      readyAt: AT,
    })
    planExecutions.set(storage, execution)
  }
  execution = planExecutions.get(storage)!

  const opened = await storage.ontology.replacementPlans.open({
    projectId: PROJECT,
    source,
    materializationId: "plan",
    execution,
    commit: {
      projectId: PROJECT,
      id: `plan-commit-${at}`,
      idempotencyKey: `projection:plan-commit-${at}`,
      requestHash: `hash:plan-commit-${at}`,
      executionId: `test_projection_execution:${runId}`,
      origin: {
        kind: "projection",
        projectionId: v1.projection.id,
        projectionRunId: runId,
        datasetId: datasetVersion.datasetId,
        datasetVersionId: datasetVersion.versionId,
      },
      ontologyRevision: identity.ontologyRevision,
      projectionRevision: identity.projectionRevision,
      ownershipHash: identity.ownershipHash,
      intent: { kind: "projection", source, datasetVersion },
      committedAt: at,
    },
  })
  return opened.committedAt
}

const planExecutions = new WeakMap<Storage, ProjectionExecution>()

/** Every write path a removal reaches, as stored: compared whole before and after a failed run. */
export async function dumpStores(storage: Storage) {
  const objects = []
  const edits = []
  for (const objectTypeId of [JOB, INSPECTION]) {
    const page = await storage.objects.listByPrimaryIdPage({
      projectId: PROJECT,
      objectTypeId,
      limit: 100,
    })
    objects.push(...page.objects.map(({ score: _score, ...object }) => object))
    const stored = await storage.ontology.typeShapes.listEdits({
      projectId: PROJECT,
      objectTypeId,
      limit: 100,
    })
    edits.push(...stored.edits)
  }

  return {
    objects,
    edits,
    shapes: await storage.ontology.typeShapes.list({ projectId: PROJECT }),
    commits: (await storage.ontology.commits.list({ projectId: PROJECT, limit: 1 })).total,
    openRun: await storage.ontology.migrations?.getOpenRun({ projectId: PROJECT }),
    settled: await storage.ontology.migrations?.listSettled({ projectId: PROJECT }),
    unique: await storage.ontology.uniqueValues.listPrepared({ projectId: PROJECT }),
  }
}

export function jobRef(primaryId: string, objectTypeId: string = JOB) {
  return { objectTypeId, primaryId }
}

export function technicianRef(primaryId: string) {
  return { objectTypeId: Technician.id, primaryId }
}

function at(seconds: number): string {
  return new Date(Date.parse(AT) + seconds * 1_000).toISOString()
}

function edits(storage: Storage, committedAt: string) {
  const materializer = materializerFor(storage, committedAt).withScope(
    createTestingScope({
      projectId: PROJECT,
      executionId: "migration-contract-execution",
      requestId: "migration-contract-request",
      correlationId: "migration-contract-correlation",
    })
  )

  return {
    commit(operations: readonly OntologyEditOperation[]) {
      return materializer.edits.commit({
        mode: "atomic",
        source: { kind: "runtime", requestId: `migration-edit-${crypto.randomUUID()}` },
        operations,
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
    },
  }
}

function materializerFor(storage: Storage, committedAt: string) {
  return createOntologyMaterializer({
    projectId: PROJECT,
    ontology: v1.ontology,
    projections: v1.projections,
    storage,
    dependencies: {
      batching: { sourceStageRows: 1, statePageRows: 1, planChunkRows: 1 },
      clock: () => new Date(committedAt),
    },
  })
}

function patch(
  primaryId: string,
  set: Readonly<Record<string, JsonValue>>,
  unset: readonly string[] = []
): OntologyEditOperation {
  return {
    id: `patch-${primaryId}`,
    kind: "object.patch",
    ref: jobRef(primaryId),
    set,
    unset,
    reset: [],
  }
}

/** One dataset row: the job's projected `gate`, or `gate` named absent, its lead and its depot. */
function entry(primaryId: string, gate?: string, lead?: string): ProjectionSourceEntry {
  const ref = jobRef(primaryId)
  return {
    root: { kind: "object", ref },
    assertions: [
      {
        kind: "object",
        ref,
        properties: gate === undefined ? { id: primaryId } : { id: primaryId, gate },
        ...(gate === undefined ? { absentSourcePropertyIds: ["gate"] } : {}),
      },
      {
        kind: "link" as const,
        ref: { source: ref, linkId: "depot", target: technicianRef("t-1") },
      },
      ...(lead
        ? [
            {
              kind: "link" as const,
              ref: { source: ref, linkId: "lead", target: technicianRef(lead) },
            },
          ]
        : []),
    ],
  }
}

/** Replaces the projection's source with `values`, each stamped as updated at `sourceUpdatedAt`. */
async function publish(
  storage: Storage,
  version: number,
  values: readonly ProjectionSourceEntry[],
  sourceUpdatedAt: string
) {
  const datasetVersion = {
    datasetId: v1.jobs.id,
    versionId: `jobs-v${version}`,
    createdAt: sourceUpdatedAt,
  }
  const resolved = v1.projections.resolveSource(v1.projection.id)
  const runId = `migration-jobs-run-${version}`
  const { execution } = await startTestProjectionRun(storage, {
    id: runId,
    projectId: PROJECT,
    identity: {
      projectionId: v1.projection.id,
      datasetVersion,
      ontologyRevision: resolved.ontologyRevision,
      projectionRevision: resolved.projectionRevision,
      ownershipHash: resolved.ownershipHash,
      projectionKind: "object",
      protocol: "replacement",
    },
    target: { objectTypeId: JOB },
  })

  const stored = await storage.executions.getById({
    projectId: PROJECT,
    id: `test_projection_execution:${runId}`,
  })
  if (!stored) throw new Error(`Test execution for '${runId}' is missing.`)

  const bound = materializerFor(storage, sourceUpdatedAt).withScope(
    restoreTrustedPrimitiveExecutionScope({
      execution: stored,
      primitive: { kind: "projection", id: v1.projection.id, runId },
    })
  )
  const stamped = values.map((value) => ({
    ...value,
    assertions: value.assertions.map((assertion) =>
      assertion.kind === "object" ? { ...assertion, sourceUpdatedAt } : assertion
    ),
  }))

  return bound.projections.replace({
    source: { projectionId: v1.projection.id },
    datasetVersion,
    execution,
    entries: (async function* () {
      yield* stamped
    })(),
  })
}
