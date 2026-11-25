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
import { restoreTrustedPrimitiveExecutionScope } from "../execution/durable"
import { createTestingScope } from "../execution/scopes"
import type { JsonValue } from "../json"
import {
  createOntologyMaterializer,
  type OntologyEditOperation,
  ProjectionRegistry,
  type ProjectionSourceEntry,
} from "../materializer"
import type { TypeShape } from "../ontology/type-shapes"
import type { TypeShapeProbe } from "../storage/ontology"
import { startTestProjectionRun } from "./projection-execution"

export interface TypeShapesContractProvider<TStorage extends Storage> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
  /**
   * Stores the marker an old storage migration left on a cardinality-one slot it could not
   * convert. Only providers with such migrations can hold one.
   */
  readonly writeLegacyLinkConflict?: (
    storage: TStorage,
    slot: {
      readonly projectId: string
      readonly sourceTypeId: string
      readonly sourcePrimaryId: string
      readonly linkId: string
    }
  ) => Promise<void>
}

const PROJECT = "type-shapes-contract"
const OTHER_PROJECT = "type-shapes-contract-other"

const Technician = defineObjectType({
  id: "ShapeContractTechnician",
  name: "Technician",
  properties: [prop("id", "string", { primary: true, required: true })],
})

const Job = defineObjectType({
  id: "ShapeContractJob",
  name: "Job",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("gate", "string", { nullable: true }),
    prop("note", "string"),
    prop("crewLead", "string"),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
  links: [
    link("crew", Technician, { cardinality: "many" }),
    link("lead", Technician, { cardinality: "one" }),
  ],
})

/** Inherits everything from `Job`, and stores its own rows. */
const Inspection = defineObjectType({
  id: "ShapeContractInspection",
  name: "Inspection",
  extends: Job.id,
  properties: [],
})

const jobs = defineDataset("shape_contract_jobs", {
  schema: [
    col("id", "string"),
    col("gate", "string", { nullable: true }),
    col("lead_id", "string", { nullable: true }),
    col("updated_at", "timestamp"),
  ],
})

const jobProjection = defineProjection("shape_contract_jobs", Job)
  .fromDataset(jobs)
  .properties({ id: "id", gate: "gate" })
  .withLinks({ lead: { link: Job.l.lead, sourceField: "lead_id", target: Technician } })
  .resolveConflicts({ strategy: "mostRecent", sourceTimestamp: "updated_at" })

const ontology = new OntologyRegistry({ sources: [Technician, Job, Inspection] })

const projections = new ProjectionRegistry({
  projections: [jobProjection],
  ontology,
  datasetsById: new Map<string, DatasetDefinition>([[jobs.id, jobs]]),
})

const SHAPE: TypeShape = {
  properties: { id: { primary: true, required: true, schema: "string" } },
  links: {},
}

/**
 * The stored shapes of a provider, and the probes that read each store a property or a link can
 * live in: objects, edits (a losing one and an unset included), source rows (absent values and
 * rows a delete hides included), link edits (a cleared slot and a legacy conflict included) and
 * telemetry. Each case puts the key in one store only, where the write paths allow it.
 */
export function runTypeShapesContractSuite<TStorage extends Storage>(
  name: string,
  provider: TypeShapesContractProvider<TStorage>
): void {
  async function withStorage(run: (storage: TStorage) => Promise<void>): Promise<void> {
    const storage = await provider.createStorage()
    try {
      await run(storage)
    } finally {
      await provider.cleanup?.(storage)
    }
  }

  test(`${name} records, reads and removes a type's shape, per project`, async () => {
    await withStorage(async (storage) => {
      const shapes = storage.ontology.typeShapes
      const at = "2026-04-01T00:00:00.000Z"

      await shapes.write({
        projectId: PROJECT,
        objectTypeId: Job.id,
        shape: SHAPE,
        updatedAt: at,
      })
      await shapes.write({
        projectId: OTHER_PROJECT,
        objectTypeId: Job.id,
        shape: SHAPE,
        updatedAt: at,
      })
      expect(await shapes.list({ projectId: PROJECT })).toEqual([
        { objectTypeId: Job.id, shape: SHAPE, updatedAt: at },
      ])

      const wider: TypeShape = {
        ...SHAPE,
        properties: { ...SHAPE.properties, gate: { schema: "unknown" } },
      }
      const later = "2026-04-02T00:00:00.000Z"
      await storage.transaction(async (tx) => {
        await tx.ontology.typeShapes.lock({ projectId: PROJECT })
        await tx.ontology.typeShapes.write({
          projectId: PROJECT,
          objectTypeId: Job.id,
          shape: wider,
          updatedAt: later,
        })
      })
      expect(await shapes.list({ projectId: PROJECT })).toEqual([
        { objectTypeId: Job.id, shape: wider, updatedAt: later },
      ])

      await shapes.remove({ projectId: PROJECT, objectTypeId: Job.id })
      expect(await shapes.list({ projectId: PROJECT })).toEqual([])
      expect(await shapes.list({ projectId: OTHER_PROJECT })).toHaveLength(1)
    })
  })

  test(`${name} rolls a shape back with its transaction`, async () => {
    await withStorage(async (storage) => {
      const failure = new Error("rolled back")
      const refused = await storage
        .transaction(async (tx) => {
          await tx.ontology.typeShapes.write({
            projectId: PROJECT,
            objectTypeId: Job.id,
            shape: SHAPE,
            updatedAt: "2026-04-01T00:00:00.000Z",
          })
          throw failure
        })
        .catch((error: unknown) => error)

      expect(refused).toBe(failure)
      expect(await storage.ontology.typeShapes.list({ projectId: PROJECT })).toEqual([])
    })
  })

  test(`${name} finds a property in an object created by an action, and nothing else`, async () => {
    await withStorage(async (storage) => {
      await edits(storage).commit([create("j1", { gate: "B12" })])

      expect(await probe(storage, { kind: "property", propertyId: "gate" })).toEqual({
        holds: true,
        count: 1,
      })
      expect(await probe(storage, { kind: "property", propertyId: "note" })).toEqual({
        holds: false,
        count: 0,
      })
      expect(await probe(storage, { kind: "property", propertyId: "gate" }, OTHER_PROJECT)).toEqual(
        {
          holds: false,
          count: 0,
        }
      )
    })
  })

  // Removal proof: drop the `unset` and edit-time checks from a provider's `property` probe; this
  // fails. The unset writes an edit time too, so either check alone keeps it passing.
  test(`${name} finds a property only an unset holds`, async () => {
    await withStorage(async (storage) => {
      await publish(storage, 1, [entry("j1", { gate: "A" })])
      await edits(storage).commit([patch("j1", {}, ["note"])])

      expect(await probe(storage, { kind: "property", propertyId: "note" })).toEqual({
        holds: true,
        count: 1,
      })
    })
  })

  test(`${name} finds a property only a source row hidden by a delete holds`, async () => {
    await withStorage(async (storage) => {
      await publish(storage, 1, [entry("j1", { gate: "A" })])
      await edits(storage).commit([{ id: "delete", kind: "object.delete", ref: jobRef("j1") }])

      expect(await object(storage, "j1")).toBeNull()
      expect(await probe(storage, { kind: "property", propertyId: "gate" })).toEqual({
        holds: true,
        count: 1,
      })
    })
  })

  // Removal proof: drop the `absentSourcePropertyIds` check from a provider's `property` probe.
  test(`${name} finds a property only a source row's absent values name`, async () => {
    await withStorage(async (storage) => {
      await publish(storage, 1, [entry("j1", {}, { absent: ["gate"] })])

      expect((await object(storage, "j1"))?.properties).not.toHaveProperty("gate")
      expect(await probe(storage, { kind: "property", propertyId: "gate" })).toEqual({
        holds: true,
        count: 1,
      })
    })
  })

  test(`${name} finds a property only a telemetry series holds`, async () => {
    await withStorage(async (storage) => {
      await edits(storage).commit([create("j1", {})])
      await appendTemperature(storage, "j1")
      await edits(storage).commit([{ id: "delete", kind: "object.delete", ref: jobRef("j1") }])

      expect(await object(storage, "j1")).toBeNull()
      expect(await probe(storage, { kind: "property", propertyId: "temperature" })).toEqual({
        holds: true,
        count: 1,
      })
    })
  })

  test(`${name} lists a losing edit, which still holds its value`, async () => {
    await withStorage(async (storage) => {
      await publish(storage, 1, [entry("j1", { gate: "A" })], "2026-04-01T00:00:01.000Z")
      await edits(storage, "2026-04-01T00:00:02.000Z").commit([patch("j1", { gate: "B" })])
      // The source changes after the edit: under `mostRecent` it wins, and the edit stays.
      await publish(storage, 2, [entry("j1", { gate: "C" })], "2026-04-01T00:00:03.000Z")

      expect((await object(storage, "j1"))?.properties.gate).toBe("C")
      const page = await storage.ontology.typeShapes.listEdits({
        projectId: PROJECT,
        objectTypeId: Job.id,
        withValueOf: "gate",
        limit: 10,
      })
      expect(page.edits).toEqual([
        {
          primaryId: "j1",
          value: { kind: "patch", set: { gate: "B" }, unset: [] },
          editedAt: { gate: "2026-04-01T00:00:02.000Z" },
        },
      ])
    })
  })

  test(`${name} pages edits by primary id, deletes left out, by the property they set`, async () => {
    await withStorage(async (storage) => {
      await edits(storage).commit([
        create("j1", { gate: "A" }),
        create("j2", {}),
        create("j3", { gate: null }),
      ])
      await edits(storage).commit([create("j4", {})])
      await edits(storage).commit([{ id: "delete", kind: "object.delete", ref: jobRef("j4") }])

      const list = (input: { readonly withValueOf?: string; readonly afterPrimaryId?: string }) =>
        storage.ontology.typeShapes.listEdits({
          projectId: PROJECT,
          objectTypeId: Job.id,
          limit: 2,
          ...input,
        })

      const first = await list({})
      expect(first.edits.map((edit) => edit.primaryId)).toEqual(["j1", "j2"])
      expect(first.nextPrimaryId).toBe("j2")
      const second = await list({ afterPrimaryId: "j2" })
      expect(second.edits.map((edit) => edit.primaryId)).toEqual(["j3"])
      expect(second.nextPrimaryId).toBeUndefined()

      const holding = await list({ withValueOf: "gate" })
      expect(holding.edits.map((edit) => edit.primaryId)).toEqual(["j1", "j3"])
      // An edit never stores the primary property: the object's identity holds it.
      expect(holding.edits[1]?.value).toEqual({ kind: "create", properties: { gate: null } })
    })
  })

  test(`${name} finds the objects created by actions that lack a property, not projected ones`, async () => {
    await withStorage(async (storage) => {
      await publish(storage, 1, [
        entry("projected", { gate: "A" }),
        entry("adopted", { gate: "B" }),
      ])
      await edits(storage).commit([
        create("created", { gate: "C" }),
        create("filled", { crewLead: "ada" }),
        patch("projected", { note: "edited" }),
      ])

      const missing = { kind: "missingRequired", propertyId: "crewLead" } as const
      expect(await probe(storage, missing)).toEqual({ holds: true, count: 1 })
      expect(await probe(storage, { kind: "missingRequired", propertyId: "gate" })).toEqual({
        holds: true,
        count: 1,
      })
    })
  })

  // Removal proof: drop the live-root exclusion from a provider's `missingRequired` probe; this and
  // the case above then count projected objects.
  test(`${name} counts an object created by an action as projected once a projection feeds it`, async () => {
    await withStorage(async (storage) => {
      await edits(storage).commit([create("j1", { gate: "A" })])
      expect(await probe(storage, { kind: "missingRequired", propertyId: "crewLead" })).toEqual({
        holds: true,
        count: 1,
      })

      await publish(storage, 1, [entry("j1", { gate: "A" })])
      expect(await probe(storage, { kind: "missingRequired", propertyId: "crewLead" })).toEqual({
        holds: false,
        count: 0,
      })
    })
  })

  // Removal proof: drop the `unset` holder from a provider's `missingRequired` probe; a projected
  // object an edit cleared then passes, and every later write to it fails once it is required.
  test(`${name} finds an object an edit cleared a property of, projected or not`, async () => {
    await withStorage(async (storage) => {
      await publish(storage, 1, [entry("projected", { gate: "A" })])
      await edits(storage).commit([create("created", { gate: "B", crewLead: "ada" })])
      await edits(storage).commit([
        patch("projected", {}, ["gate"]),
        patch("created", {}, ["crewLead"]),
      ])

      expect(await probe(storage, { kind: "missingRequired", propertyId: "gate" })).toEqual({
        holds: true,
        count: 1,
      })
      expect(await probe(storage, { kind: "missingRequired", propertyId: "crewLead" })).toEqual({
        holds: true,
        count: 1,
      })
    })
  })

  test(`${name} lists the link and telemetry ids a type's data holds`, async () => {
    await withStorage(async (storage) => {
      expect(
        await storage.ontology.typeShapes.listHeldKeys({ projectId: PROJECT, objectTypeId: Job.id })
      ).toEqual({ linkIds: [], seriesPropertyIds: [] })

      await edits(storage).commit([create("j1", {}), technician("t1"), crew("j1", "t1")])
      await appendTemperature(storage, "j1")
      // Only a source row holds `lead`: its target doesn't exist.
      await publish(storage, 1, [entry("j2", {}, { lead: "ghost" })])

      expect(
        await storage.ontology.typeShapes.listHeldKeys({ projectId: PROJECT, objectTypeId: Job.id })
      ).toEqual({ linkIds: ["crew", "lead"], seriesPropertyIds: ["temperature"] })
      expect(
        await storage.ontology.typeShapes.listHeldKeys({
          projectId: PROJECT,
          objectTypeId: Technician.id,
        })
      ).toEqual({ linkIds: [], seriesPropertyIds: [] })
    })
  })

  test(`${name} finds a link in a link edit`, async () => {
    await withStorage(async (storage) => {
      await edits(storage).commit([create("j1", {}), technician("t1"), crew("j1", "t1")])

      expect(await probe(storage, { kind: "link", linkId: "crew" })).toEqual({
        holds: true,
        count: 1,
      })
      expect(await probe(storage, { kind: "link", linkId: "lead" })).toEqual({
        holds: false,
        count: 0,
      })
    })
  })

  test(`${name} finds a link a cleared slot holds`, async () => {
    await withStorage(async (storage) => {
      await edits(storage).commit([technician("t1")])
      await publish(storage, 1, [entry("j1", {}, { lead: "t1" })])
      await edits(storage).commit([
        {
          id: "clear",
          kind: "link.delete",
          ref: { source: jobRef("j1"), linkId: "lead", target: technicianRef("t1") },
        },
      ])

      expect(await probe(storage, { kind: "link", linkId: "lead" })).toEqual({
        holds: true,
        count: 1,
      })
    })
  })

  test(`${name} finds a link only a source row holds`, async () => {
    await withStorage(async (storage) => {
      // The target doesn't exist: the link is asserted, not effective.
      await publish(storage, 1, [entry("j1", {}, { lead: "ghost" })])

      expect(await probe(storage, { kind: "link", linkId: "lead" })).toEqual({
        holds: true,
        count: 1,
      })
    })
  })

  test(`${name} finds a link only a legacy conflict holds`, async () => {
    if (!provider.writeLegacyLinkConflict) return

    await withStorage(async (storage) => {
      await provider.writeLegacyLinkConflict!(storage, {
        projectId: PROJECT,
        sourceTypeId: Job.id,
        sourcePrimaryId: "j1",
        linkId: "lead",
      })

      expect(await probe(storage, { kind: "link", linkId: "lead" })).toEqual({
        holds: true,
        count: 1,
      })
      expect(await probe(storage, { kind: "type" })).toEqual({ holds: true, count: 1 })
    })
  })

  test(`${name} finds a type's data in any store, and only its own rows for a subtype`, async () => {
    await withStorage(async (storage) => {
      expect(await probe(storage, { kind: "type" })).toEqual({ holds: false, count: 0 })

      await edits(storage).commit([
        {
          id: "inspection",
          kind: "object.create",
          ref: { objectTypeId: Inspection.id, primaryId: "i1" },
          properties: { id: "i1", gate: "A" },
        },
      ])
      expect(await probe(storage, { kind: "type" })).toEqual({ holds: false, count: 0 })
      expect(await probe(storage, { kind: "property", propertyId: "gate" })).toEqual({
        holds: false,
        count: 0,
      })
      expect(
        await probe(storage, { kind: "property", propertyId: "gate" }, PROJECT, Inspection.id)
      ).toEqual({
        holds: true,
        count: 1,
      })

      await publish(storage, 1, [entry("j1", { gate: "A" })])
      await edits(storage).commit([create("j2", {})])
      expect(await probe(storage, { kind: "type" })).toEqual({ holds: true, count: 2 })
    })
  })
}

async function probe(
  storage: Storage,
  read: TypeShapeProbe,
  projectId = PROJECT,
  objectTypeId: string = Job.id
): Promise<{ readonly holds: boolean; readonly count: number }> {
  const input = { projectId, objectTypeId, probe: read }
  return {
    holds: await storage.ontology.typeShapes.holds(input),
    count: await storage.ontology.typeShapes.count(input),
  }
}

function edits(storage: Storage, at = "2026-04-01T00:00:00.000Z") {
  const materializer = createMaterializer(storage, at).withScope(
    createTestingScope({
      projectId: PROJECT,
      executionId: "type-shapes-contract-execution",
      requestId: "type-shapes-contract-request",
      correlationId: "type-shapes-contract-correlation",
    })
  )

  return {
    commit(operations: readonly OntologyEditOperation[]) {
      return materializer.edits.commit({
        mode: "atomic",
        source: { kind: "runtime", requestId: `shape-edit-${crypto.randomUUID()}` },
        operations,
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
    },
    telemetry: materializer.telemetry,
  }
}

async function appendTemperature(storage: Storage, primaryId: string): Promise<void> {
  await edits(storage).telemetry.append({
    source: { kind: "runtime", requestId: `shape-reading-${primaryId}` },
    points: [
      {
        series: { object: jobRef(primaryId), propertyId: "temperature" },
        value: 21.5,
        at: "2026-04-01T00:00:00.500Z",
      },
    ],
  })
}

function createMaterializer(storage: Storage, at: string) {
  return createOntologyMaterializer({
    projectId: PROJECT,
    ontology,
    projections,
    storage,
    dependencies: {
      batching: { sourceStageRows: 1, statePageRows: 1, planChunkRows: 1 },
      clock: () => new Date(at),
    },
  })
}

function jobRef(primaryId: string) {
  return { objectTypeId: Job.id, primaryId }
}

function technicianRef(primaryId: string) {
  return { objectTypeId: Technician.id, primaryId }
}

function create(
  primaryId: string,
  properties: Readonly<Record<string, JsonValue>>
): OntologyEditOperation {
  return {
    id: `create-${primaryId}`,
    kind: "object.create",
    ref: jobRef(primaryId),
    properties: { id: primaryId, ...properties },
  }
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

function technician(primaryId: string): OntologyEditOperation {
  return {
    id: `technician-${primaryId}`,
    kind: "object.create",
    ref: technicianRef(primaryId),
    properties: { id: primaryId },
  }
}

function crew(jobId: string, technicianId: string): OntologyEditOperation {
  return {
    id: `crew-${jobId}-${technicianId}`,
    kind: "link.upsert",
    ref: { source: jobRef(jobId), linkId: "crew", target: technicianRef(technicianId) },
  }
}

function object(storage: Storage, primaryId: string) {
  return storage.objects.getByPrimaryId({ projectId: PROJECT, ...jobRef(primaryId) })
}

/** One dataset row: the job's projected values, absent ones, and its lead. */
function entry(
  primaryId: string,
  properties: Readonly<Record<string, JsonValue>>,
  options: { readonly absent?: readonly string[]; readonly lead?: string } = {}
): ProjectionSourceEntry {
  const ref = jobRef(primaryId)
  return {
    root: { kind: "object", ref },
    assertions: [
      {
        kind: "object",
        ref,
        properties: { id: primaryId, ...properties },
        ...(options.absent ? { absentSourcePropertyIds: options.absent } : {}),
      },
      ...(options.lead
        ? [
            {
              kind: "link" as const,
              ref: { source: ref, linkId: "lead", target: technicianRef(options.lead) },
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
  sourceUpdatedAt = "2026-04-01T00:00:00.000Z"
) {
  const datasetVersion = {
    datasetId: jobs.id,
    versionId: `jobs-v${version}`,
    createdAt: sourceUpdatedAt,
  }
  const resolved = projections.resolveSource(jobProjection.id)
  const runId = `jobs-run-${version}`
  const { execution } = await startTestProjectionRun(storage, {
    id: runId,
    projectId: PROJECT,
    identity: {
      projectionId: jobProjection.id,
      datasetVersion,
      ontologyRevision: resolved.ontologyRevision,
      projectionRevision: resolved.projectionRevision,
      ownershipHash: resolved.ownershipHash,
      projectionKind: "object",
      protocol: "replacement",
    },
    target: { objectTypeId: Job.id },
  })

  const stored = await storage.executions.getById({
    projectId: PROJECT,
    id: `test_projection_execution:${runId}`,
  })
  if (!stored) throw new Error(`Test execution for '${runId}' is missing.`)

  const bound = createMaterializer(storage, sourceUpdatedAt).withScope(
    restoreTrustedPrimitiveExecutionScope({
      execution: stored,
      primitive: { kind: "projection", id: jobProjection.id, runId },
    })
  )

  const stamped = values.map((value) => ({
    ...value,
    assertions: value.assertions.map((assertion) =>
      assertion.kind === "object" ? { ...assertion, sourceUpdatedAt } : assertion
    ),
  }))

  return bound.projections.replace({
    source: { projectionId: jobProjection.id },
    datasetVersion,
    execution,
    entries: (async function* () {
      yield* stamped
    })(),
  })
}
