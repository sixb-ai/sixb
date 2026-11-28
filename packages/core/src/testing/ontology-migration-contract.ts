import { expect, test } from "bun:test"
import type { Storage } from ".."
import { defineMigration, type MigrationDefinition } from "../migrations"
import { applyOntologyMigrations, resumeOntologyMigration } from "../migrations/run"
import { vectorConfiguration, vectorSources } from "../objects/vectors/profile"
import type { OntologyRegistry } from "../ontology"
import { migrateStorage } from "../storage/migrations"
import { applyTypeShapes } from "../storage/migrations/migrate-storage"
import {
  checkTypeShapes,
  OntologyMigrationApplyingError,
  recordTypeShapes,
  TypeShapeMismatchError,
} from "../storage/migrations/type-shapes"
import type { OntologyMigrationStorage } from "../storage/ontology"
import { migrationRunTotals } from "../storage/ontology/migrations"
import {
  ARTIFACT,
  closeReleases,
  dumpStores,
  firstRelease,
  INSPECTION,
  JOB,
  jobRef,
  openReplacementPlan,
  PROJECT,
  release,
  removeGate,
  renamed,
  renameGate,
  seedJobs,
  TECHNICIAN,
  TIMEOUT_MS,
  v1,
  v2,
  wideRelease,
} from "./ontology-migration-contract-fixture"

export interface OntologyMigrationContractProvider<TStorage extends Storage> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
  /** Stores the marker an old storage migration left on a slot, for a provider that has one. */
  readonly writeLegacyLinkConflict?: (
    storage: TStorage,
    slot: {
      readonly projectId: string
      readonly sourceTypeId: string
      readonly sourcePrimaryId: string
      readonly linkId: string
    }
  ) => Promise<void>
  /**
   * What the provider prints of every index, statistic and generated column a type's queries are
   * built on, for a provider that builds them. A text column starts with its name.
   */
  readonly readQueryStructures?: (storage: TStorage, objectTypeId: string) => Promise<string[]>
}

/**
 * What a run writes, on every provider: `removeProperty` across every store that holds the key, in
 * batches that each commit once, under the run's kernel execution and without outbox rows; what a
 * crash leaves and how a resume finishes it; and when a migration settles.
 *
 * Removal proofs, each failing a case below: in a provider, drop the key condition of its objects
 * statement, its `unset` or `absentSourcePropertyIds` rewrite, its sources or derived lane, its
 * vector delete, or its stale-`batches` check; in core, drop the `settled` set the
 * gate passes to `coverChanges`, the unique preparation before the run, or the `migrating`
 * refusals.
 */
export function runOntologyMigrationContractSuite<TStorage extends Storage>(
  name: string,
  provider: OntologyMigrationContractProvider<TStorage>
): void {
  async function withSeeded(run: (storage: TStorage) => Promise<void>): Promise<void> {
    const storage = await provider.createStorage()
    try {
      await seedJobs(storage)
      await run(storage)
    } finally {
      await closeReleases(storage)
      await provider.cleanup?.(storage)
    }
  }

  // Removal proof: in a provider's `startRun` and `finishRun`, leave `previous` as it was: the
  // release before the run may then start as a role on the data the run rewrote.
  test(
    `${name} leaves no previous shape to a type a run rewrote`,
    async () => {
      await withSeeded(async (storage) => {
        for (const row of await storage.ontology.typeShapes.list({ projectId: PROJECT })) {
          await storage.ontology.typeShapes.write({
            ...row,
            projectId: PROJECT,
            previous: row.shape,
          })
        }

        await migrate(storage, { batchRows: 1_000 })
        const rows = await storage.ontology.typeShapes.list({ projectId: PROJECT })
        for (const objectTypeId of [JOB, INSPECTION]) {
          expect(rows.find((row) => row.objectTypeId === objectTypeId)?.previous).toBeNull()
        }
      })
    },
    TIMEOUT_MS
  )

  test(
    `${name} removes a property from every store that holds it`,
    async () => {
      await withSeeded(async (storage) => {
        const before = await versions(storage)
        const updatedAt = (await object(storage, "j-1"))?.updatedAt
        const outbox = await storage.ontology.outbox.summarize({ projectId: PROJECT })

        const run = await migrate(storage, { batchRows: 1_000 })
        expect(run?.status).toBe("applied")

        for (const objectTypeId of [JOB, INSPECTION]) {
          for (const propertyId of ["gate", "contract"]) {
            const probe = { kind: "property", propertyId } as const
            expect(
              await storage.ontology.typeShapes.holds({ projectId: PROJECT, objectTypeId, probe })
            ).toBe(false)
          }
        }

        const job = await object(storage, "j-1")
        expect(job?.properties).toEqual({ id: "j-1", note: "first", temperature: 21.5 })
        expect(job?.updatedAt).toEqual(updatedAt)
        await expectVersionsBumpedOnce(storage, before)
        expect((await object(storage, "i-1", INSPECTION))?.properties).not.toHaveProperty("gate")

        const edits = await storage.ontology.typeShapes.listEdits({
          projectId: PROJECT,
          objectTypeId: JOB,
          limit: 100,
        })
        for (const edit of edits.edits) {
          const values = edit.value.kind === "create" ? edit.value.properties : edit.value.set
          expect(values).not.toHaveProperty("gate")
          expect(edit.editedAt).not.toHaveProperty("gate")
          if (edit.value.kind === "patch") expect(edit.value.unset).not.toContain("gate")
        }
        // The other keys stay, as JSON: an object, an emptied patch, its other edit times.
        const edit = (id: string) => edits.edits.find((candidate) => candidate.primaryId === id)
        expect(edit("j-1")?.value).toEqual({ kind: "create", properties: { note: "first" } })
        expect(Object.keys(edit("j-1")?.editedAt ?? {})).toEqual(["note"])
        expect(edit("p-1")?.value).toEqual({ kind: "patch", set: {}, unset: [] })
        // Removal proof: in SQLite, read `unset` through a bare `value` inside `json_each`, which is
        // json_each's own column; `note` then goes with `gate`.
        expect(edit("p-2")?.value).toEqual({ kind: "patch", set: {}, unset: ["note"] })

        const vectors = await storage.ontology.vectors?.list({
          projectId: PROJECT,
          ref: jobRef("j-1"),
        })
        expect(vectors?.map((vector) => vector.profile)).toEqual(["notes"])
        const holders = await storage.objects.listArtifactHolders?.({
          projectId: PROJECT,
          artifactId: ARTIFACT,
          limit: 10,
        })
        expect(holders?.holders).toEqual([])
        const unique = await storage.ontology.uniqueValues.listPrepared({ projectId: PROJECT })
        expect(unique.filter((property) => property.propertyId === "gate")).toEqual([])

        // Telemetry is never rewritten: removing a series stays refused.
        const latest = await storage.timeseries.getLatest({
          projectId: PROJECT,
          objectTypeId: JOB,
          objectId: "j-1",
          propertyId: "temperature",
        })
        expect(latest?.value).toBe(21.5)

        // No event, no outbox row: a migration changes the shape, not the business.
        expect(await storage.ontology.outbox.summarize({ projectId: PROJECT })).toEqual(outbox)

        const shapes = await storage.ontology.typeShapes.list({ projectId: PROJECT })
        expect(shapes.map((row) => [row.objectTypeId, row.state])).toEqual([
          [INSPECTION, "current"],
          [JOB, "current"],
          [TECHNICIAN, "current"],
        ])
        expect(shapes.find((row) => row.objectTypeId === JOB)?.shape.properties).not.toHaveProperty(
          "gate"
        )
        expect(await storage.ontology.migrations?.listSettled({ projectId: PROJECT })).toEqual([
          { objectTypeId: INSPECTION, migrationId: "job-gate" },
          { objectTypeId: JOB, migrationId: "job-gate" },
        ])
      })
    },
    TIMEOUT_MS
  )

  test(
    `${name} commits each batch once, as the run's kernel execution, and bumps versions once`,
    async () => {
      await withSeeded(async (storage) => {
        const before = await versions(storage)
        const run = await migrate(storage, { batchRows: 2 })
        if (!run) throw new Error("No run was planned.")

        const commits = await storage.ontology.commits.list({
          projectId: PROJECT,
          committedAt: run.startedAt,
          limit: 100,
        })
        // One commit per batch that rewrote an object or an edit, named by its lane and batch.
        const ids = commits.commits.map((commit) => commit.id)
        expect(ids.length).toBeGreaterThan(2)
        expect(new Set(ids).size).toBe(ids.length)
        for (const commit of commits.commits) {
          const [ordinal, batch] = commit.id
            .slice(run.id.length + 1)
            .split("_")
            .map(Number)
          expect(batch).toBeLessThan(run.lanes[ordinal!]!.batches)
          expect(commit.origin).toEqual({
            kind: "runtime",
            requestId: `${run.id}:${ordinal}:${batch}`,
          })
          expect(commit.executionId).toBe(run.executionId)
        }
        expect(run.lanes.every((lane) => lane.cursor === null)).toBe(true)
        // A provider that applies lanes side by side splits the type: the ranges are exercised.
        if (storage.ontology.migrations!.parallelism > 1) {
          const jobRanges = run.lanes.filter(
            (lane) => lane.lane.kind === "objects" && lane.lane.objectTypeId === JOB
          )
          expect(jobRanges.length).toBeGreaterThan(1)
        }
        const execution = await storage.executions.getById({
          projectId: PROJECT,
          id: run.executionId,
        })
        expect(execution?.executor).toEqual({
          type: "kernel",
          operation: { type: "ontology.migrate", runId: run.id },
        })

        await expectVersionsBumpedOnce(storage, before)
      })
    },
    TIMEOUT_MS
  )

  test(
    `${name} resumes a run a crash stopped, from its stored plan, without applying a batch twice`,
    async () => {
      await withSeeded(async (storage) => {
        const before = await versions(storage)
        const planned = await check(storage, "deploy")
        const crashed = await migrate(failingAfter(storage, 2), { batchRows: 2 }).catch(
          (error: unknown) => error
        )
        expect(String(crashed)).toContain("Run `sixb db migrate` to resume it.")

        // Past the point of no return: a role refuses to start, `--check` says it applies, nothing
        // records a shape over the run's, and no second run starts.
        const shapes = await storage.ontology.typeShapes.list({ projectId: PROJECT })
        expect(shapes.map((row) => row.state)).toEqual(["migrating", "migrating", "current"])
        const refused = await check(storage, "role").catch((error: unknown) => error)
        expect(refused).toBeInstanceOf(OntologyMigrationApplyingError)
        expect((await check(storage, "check")).applying).toEqual([INSPECTION, JOB])
        const recorded = await recordTypeShapes(storage, planned).catch((error: unknown) => error)
        expect(recorded).toBeInstanceOf(OntologyMigrationApplyingError)
        const [job] = shapes.filter((row) => row.objectTypeId === JOB)
        await storage.ontology.typeShapes.write({
          projectId: PROJECT,
          ...job!,
          updatedAt: job!.updatedAt,
        })
        expect((await storage.ontology.typeShapes.list({ projectId: PROJECT }))[1]?.state).toBe(
          "migrating"
        )

        const open = await storage.ontology.migrations!.getOpenRun({ projectId: PROJECT })
        if (!open) throw new Error("The run isn't open.")
        expect(open.lanes.reduce((sum, lane) => sum + lane.batches, 0)).toBe(2)
        const second = await storage
          .transaction((tx) =>
            tx.ontology.migrations!.startRun({ ...open, id: "second", parts: 1 })
          )
          .catch((error: unknown) => error)
        expect(String(second)).toContain(`'${open.id}' is being applied`)

        // A second applier holding a stale count gets a conflict, and writes nothing.
        const lane = open.lanes.find((candidate) => candidate.cursor !== null)!
        const stale = await storage.ontology
          .migrations!.applyBatch({
            projectId: PROJECT,
            runId: open.id,
            ordinal: lane.ordinal,
            batches: lane.batches + 1,
            commit: (await storage.ontology.commits.list({ projectId: PROJECT, limit: 1 }))
              .commits[0]!,
            batchRows: 2,
          })
          .catch((error: unknown) => error)
        expect(String(stale)).toContain("moved on while this batch ran")

        // The code a resume runs with doesn't matter: the plan is the run's.
        const resumed = await resumeOntologyMigration({ storage, projectId: PROJECT, batchRows: 2 })
        expect(resumed?.status).toBe("applied")
        expect(migrationRunTotals(resumed!).counts.objects).toBe(
          [...before.values()].filter((row) => row.holds).length
        )
        await expectVersionsBumpedOnce(storage, before)
        expect((await check(storage, "check")).applying).toEqual([])
      })
    },
    TIMEOUT_MS
  )

  test(
    `${name} writes nothing when a check fails before the point of no return`,
    async () => {
      await withSeeded(async (storage) => {
        // Two jobs share a note the next release makes unique: the dry run names them.
        await migrateStorage(storage, {
          projectId: PROJECT,
          ontology: v1.ontology,
          ontologyShapes: "deploy",
        })
        for (const id of ["j-2", "j-3"]) {
          await firstRelease(storage)
            .objects(v1.Job)
            .upsert({ properties: { id, note: "shared" } })
        }
        const before = await dumpStores(storage)

        const unique = release({ gate: null, contract: null, links: true, uniqueNote: true })
        const failed = await migrateStorage(storage, {
          projectId: PROJECT,
          ontology: unique.ontology,
          migrations: [removeGate],
          ontologyShapes: "deploy",
        }).catch((error: unknown) => error)

        expect(String(failed)).toContain("Cannot make 'MigrationJob.note' unique")
        expect(await dumpStores(storage)).toEqual(before)
      })
    },
    TIMEOUT_MS
  )

  // Removal proof: in `planPendingSteps`, leave out every step of a settled migration; the key
  // the old release wrote back then needs a new migration id.
  // Removal proof: in SQLite, give `json_remove` every path in one call (it takes 127 arguments
  // at most), or `OR` one `json_type` per key (the expression tree is 1,000 deep at most); this
  // run then fails past the point of no return, and every resume the same way.
  test(
    `${name} removes four hundred properties of one type in one migration`,
    async () => {
      const storage = await provider.createStorage()
      try {
        const names = Array.from({ length: 400 }, (_, index) => `old${index + 1}`)
        const before = wideRelease(names)
        const after = wideRelease([])
        const options = { projectId: PROJECT, ontologyShapes: "deploy" as const }

        await migrateStorage(storage, { ...options, ontology: before.ontology })
        const values = Object.fromEntries(names.map((id) => [id, `value of ${id}`]))
        await firstRelease(storage, before)
          .objects(before.Job)
          .upsert({ properties: { id: "w-1", ...values } })

        let migration = defineMigration("wide-remove", after.Job)
        for (const id of names) migration = migration.removeProperty(id)
        await migrateStorage(storage, {
          ...options,
          ontology: after.ontology,
          migrations: [migration],
        })

        const job = await storage.objects.getByPrimaryId({
          projectId: PROJECT,
          objectTypeId: after.Job.id,
          primaryId: "w-1",
        })
        expect(job?.properties).toEqual({ id: "w-1" })
        const edits = await storage.ontology.typeShapes.listEdits({
          projectId: PROJECT,
          objectTypeId: after.Job.id,
          limit: 10,
        })
        expect(edits.edits.map((edit) => [edit.value, edit.editedAt])).toEqual([
          [{ kind: "create", properties: {} }, {}],
        ])
      } finally {
        await closeReleases(storage)
        await provider.cleanup?.(storage)
      }
    },
    TIMEOUT_MS
  )

  test(
    `${name} removes a key again when an old release wrote it back`,
    async () => {
      await withSeeded(async (storage) => {
        await migrate(storage)

        // A rollback: the first release runs again, and writes `gate`.
        await migrateStorage(storage, {
          projectId: PROJECT,
          ontology: v1.ontology,
          ontologyShapes: "deploy",
        })
        await firstRelease(storage)
          .objects(v1.Job)
          .upsert({ properties: { id: "j-2", gate: "again" } })

        const again = await migrate(storage)
        expect(again?.plan.types.map((type) => type.objectTypeId)).toEqual([JOB])
        expect((await object(storage, "j-2"))?.properties).not.toHaveProperty("gate")
      })
    },
    TIMEOUT_MS
  )

  // Removal proof: drop the replacement plans' delete from a provider's `startRun`; the plan
  // opened before the run then keeps its time, and may hold `gate`.
  test(
    `${name} drops the replacement plans a run's keys may be in`,
    async () => {
      await withSeeded(async (storage) => {
        const first = "2026-04-02T00:00:00.000Z"
        const later = "2026-04-03T00:00:00.000Z"
        expect(await openReplacementPlan(storage, first)).toBe(first)
        expect(await openReplacementPlan(storage, later)).toBe(first)

        await migrate(storage)
        expect(await openReplacementPlan(storage, later)).toBe(later)
      })
    },
    TIMEOUT_MS
  )

  // Removal proof: in `applyTypeShapes`, prepare unique values before the run; the removed `gate`
  // loses its values before the point of no return, and the old release restarts without.
  test(
    `${name} keeps a removed key's unique values when the run doesn't start`,
    async () => {
      await withSeeded(async (storage) => {
        const options = { projectId: PROJECT, ontology: v2.ontology, migrations: [removeGate] }
        const planned = await check(storage, "deploy")

        // Another deploy recorded a shape meanwhile: the run refuses to start.
        const [job] = (await storage.ontology.typeShapes.list({ projectId: PROJECT })).filter(
          (row) => row.objectTypeId === JOB
        )
        await storage.ontology.typeShapes.write({
          projectId: PROJECT,
          objectTypeId: JOB,
          shape: { ...job!.shape, links: { moved: { targets: [], cardinality: "many" } } },
          previous: job!.previous,
          updatedAt: job!.updatedAt,
        })
        const refused = await applyTypeShapes(storage, options, planned).catch(
          (error: unknown) => error
        )

        expect(String(refused)).toContain("changed while it was being checked")
        expect(await storage.ontology.migrations!.getOpenRun({ projectId: PROJECT })).toBeNull()
        const unique = await storage.ontology.uniqueValues.listPrepared({ projectId: PROJECT })
        expect(unique.map((property) => property.propertyId)).toContain("gate")
      })
    },
    TIMEOUT_MS
  )

  test(
    `${name} settles the migrations a new database never needs`,
    async () => {
      const storage = await provider.createStorage()
      try {
        await migrateStorage(storage, {
          projectId: PROJECT,
          ontology: v2.ontology,
          migrations: [removeGate],
          ontologyShapes: "deploy",
        })
        expect(await storage.ontology.migrations?.listSettled({ projectId: PROJECT })).toEqual([
          { objectTypeId: INSPECTION, migrationId: "job-gate" },
          { objectTypeId: JOB, migrationId: "job-gate" },
        ])
      } finally {
        await provider.cleanup?.(storage)
      }
    },
    TIMEOUT_MS
  )

  // Removal proofs: in a provider, drop the rename from `unset` or from the edit times, the vector
  // move, the link delete or the source link delete, and this case fails; in SQLite, read `unset`
  // through a bare `value` inside `json_each`, which is json_each's own column.
  test(
    `${name} renames a property in every store that holds it, and removes links`,
    async () => {
      await withSeeded(async (storage) => {
        if (provider.writeLegacyLinkConflict) {
          await provider.writeLegacyLinkConflict(storage, {
            projectId: PROJECT,
            sourceTypeId: JOB,
            sourcePrimaryId: "j-3",
            linkId: "lead",
          })
        }
        const before = await versions(storage)
        const state = await readJobs(storage)
        const queued = await queuedIndexing(storage, "j-2")
        expect(queued?.configuration).toBe(vectorConfiguration(v1.Job.search!.vectors!.gates!))
        const jobsSource = { projectId: PROJECT, source: { projectionId: v1.projection.id } }
        const assertions = (await storage.ontology.sources.getActive(jobsSource))?.assertionCount

        await deploy(storage, renamed.ontology, [renameGate])

        for (const objectTypeId of [JOB, INSPECTION]) {
          for (const probe of [
            { kind: "property", propertyId: "gate" },
            { kind: "property", propertyId: "contract" },
            { kind: "link", linkId: "crew" },
            { kind: "link", linkId: "lead" },
          ] as const) {
            expect(
              await storage.ontology.typeShapes.holds({ projectId: PROJECT, objectTypeId, probe })
            ).toBe(false)
          }
        }
        await expectVersionsBumpedOnce(storage, before)
        // The active version's two projected leads went, and its count with them.
        expect((await storage.ontology.sources.getActive(jobsSource))?.assertionCount).toBe(
          assertions! - 2
        )

        // Values, edits and their times, source rows and absent ids, under the new ids.
        const after = await readJobs(storage)
        expect(after.get("j-1")?.effective?.properties).toEqual({
          id: "j-1",
          gateCode: "A1",
          note: "first",
          agreement: { type: "artifact", id: ARTIFACT },
          temperature: 21.5,
        })
        const { gate, contract, ...kept } = state.get("j-1")?.override?.editedAt ?? {}
        expect(gate).toBeDefined()
        expect(after.get("j-1")?.override?.editedAt).toEqual({
          ...kept,
          gateCode: gate,
          agreement: contract,
        })
        expect(after.get("p-1")?.override?.value).toEqual({
          kind: "patch",
          set: { gateCode: "E1" },
          unset: [],
        })
        expect(after.get("p-1")?.override?.editedAt).toEqual({
          gateCode: state.get("p-1")?.override?.editedAt?.gate ?? "missing",
        })
        expect(after.get("p-1")?.effective?.properties.gateCode).toBe("P1b")
        expect(after.get("p-1")?.source?.assertion).toMatchObject({
          properties: { gateCode: "P1b" },
        })
        expect(after.get("p-2")?.override?.value).toEqual({
          kind: "patch",
          set: {},
          unset: ["gateCode", "note"],
        })
        expect(after.get("p-3")?.source?.assertion).toMatchObject({
          absentSourcePropertyIds: ["gateCode"],
        })
        expect(after.get("i-1")?.effective?.properties.gateCode).toBe("I1")

        // The edit that set the value still explains it, by its commit or, when other edit
        // commits share its instant and none names `gateCode`, by that instant: never the run.
        const renamedLineage = await firstRelease(storage, renamed)
          .objects(renamed.Job)
          .lineage("j-1")
        const source = renamedLineage?.properties.gateCode?.source ?? "none"
        expect(renamedLineage?.sources[source]).toMatchObject({
          kind: "edit",
          committedAt: state.get("j-1")?.override?.editedAt?.gate,
        })

        // File refs and vectors moved: the old embedding is found under the new profile.
        const holders = await storage.objects.listArtifactHolders?.({
          projectId: PROJECT,
          artifactId: ARTIFACT,
          limit: 10,
        })
        expect(holders?.holders.map((holder) => holder.propertyId)).toEqual(["agreement"])
        const vectors = await storage.ontology.vectors?.list({
          projectId: PROJECT,
          ref: jobRef("j-1"),
        })
        const profile = renamed.Job.search!.vectors!.gates!
        expect(vectors?.find((vector) => vector.profile === "gates")).toMatchObject({
          source: ["gateCode"],
          configuration: vectorConfiguration(profile),
          sourceFingerprint: vectorSources(["gateCode"], { gateCode: "A1" }).sourceFingerprint,
        })
        const found = await firstRelease(storage, renamed)
          .objects(renamed.Job)
          .query()
          .vector("gates", "A1", { k: 1 })
          .list()
          .catch((error: unknown) => error)
        // SQLite searches only with its vector extension, which a test run may not load.
        if (!String(found).includes("requires extension support")) {
          expect((found as { objects: { primaryId: string }[] }).objects).toMatchObject([
            { primaryId: "j-1" },
          ])
        }

        // Indexing asked for before the run follows the profile, or `prepare` would drop it.
        expect(await queuedIndexing(storage, "j-2")).toMatchObject({
          id: queued?.id,
          configuration: vectorConfiguration(profile),
          sourceFingerprint: vectorSources(["gateCode"], { gateCode: "G-j-2" }).sourceFingerprint,
        })

        // Unique values moved: another job can't take a held value, and a released one is free.
        const prepared = await storage.ontology.uniqueValues.listPrepared({ projectId: PROJECT })
        expect(prepared.map((property) => property.propertyId).sort()).toEqual([
          "gateCode",
          "gateCode",
        ])
        await expectUniqueMoved(storage)

        expect(await storage.ontology.migrations?.listSettled({ projectId: PROJECT })).toEqual([
          { objectTypeId: INSPECTION, migrationId: "job-gate-code" },
          { objectTypeId: JOB, migrationId: "job-gate-code" },
        ])
      })
    },
    TIMEOUT_MS
  )

  // Removal proof: in PostgreSQL, leave `dropMigratedQueryStructures` out of `startRun`; the
  // indexes, statistics and text columns on `gate` stay, each maintained by every later write.
  test(
    `${name} drops the query structures on a renamed key and prepares the new key's`,
    async () => {
      const read = provider.readQueryStructures
      if (!read) return

      await withSeeded(async (storage) => {
        const reads = (key: string) => (definition: string) =>
          definition.includes(`'${key}'::text`) &&
          (!definition.includes("object_type_id = '") || definition.includes(`'${JOB}'::text`))
        const textColumns = (definitions: readonly string[]) =>
          definitions.filter((definition) => definition.startsWith("sixb_qtext_")).length

        const before = await read(storage, JOB)
        expect(before.filter(reads("gate")).length).toBeGreaterThan(3)

        await deploy(storage, renamed.ontology, [renameGate])

        const after = await read(storage, JOB)
        expect(after.filter(reads("gate"))).toEqual([])
        expect(after.filter(reads("gateCode")).length).toBe(before.filter(reads("gate")).length)
        // A text column filtered on the key holds no key in its expression: its index named it.
        expect(textColumns(after)).toBe(textColumns(before))
      })
    },
    TIMEOUT_MS
  )

  // Removal proofs, in SQLite: nest each rename around the previous expression (`CASE … THEN
  // expr ELSE json_set(expr, …)`), and the parser overflows at a dozen; or `OR` one condition per
  // rename for the `to` that gives way, and the expression tree is too deep. Either fails past the
  // point of no return, and every resume the same way.
  test(
    `${name} renames five hundred properties of one type in one migration`,
    async () => {
      const storage = await provider.createStorage()
      try {
        const from = Array.from({ length: 500 }, (_, index) => `old${index + 1}`)
        const to = from.map((id) => id.replace("old", "new"))
        const before = wideRelease(from)
        const after = wideRelease(to)
        const values = Object.fromEntries(from.map((id) => [id, `value of ${id}`]))

        await deploy(storage, before.ontology)
        const jobs = firstRelease(storage, before).objects(before.Job)
        await jobs.upsert({ properties: { id: "w-1", ...values } })
        await jobs.upsert({ properties: { id: "w-2", old1: "only one" } })

        let migration = defineMigration("wide-rename", after.Job)
        for (const [index, id] of from.entries())
          migration = migration.renameProperty(id, to[index]!)
        await deploy(storage, after.ontology, [migration])

        const read = (primaryId: string) =>
          storage.objects.getByPrimaryId({
            projectId: PROJECT,
            objectTypeId: after.Job.id,
            primaryId,
          })
        expect((await read("w-1"))?.properties).toEqual({
          id: "w-1",
          ...Object.fromEntries(to.map((id, index) => [id, `value of ${from[index]}`])),
        })
        expect((await read("w-2"))?.properties).toEqual({ id: "w-2", new1: "only one" })

        const edits = await storage.ontology.typeShapes.listEdits({
          projectId: PROJECT,
          objectTypeId: after.Job.id,
          limit: 10,
        })
        const created = edits.edits.find((edit) => edit.primaryId === "w-1")!
        expect(
          created.value.kind === "create" && Object.keys(created.value.properties).sort()
        ).toEqual([...to].sort())
        expect(Object.keys(created.editedAt).sort()).toEqual([...to].sort())
      } finally {
        await closeReleases(storage)
        await provider.cleanup?.(storage)
      }
    },
    TIMEOUT_MS
  )

  test(
    `${name} renames one property and removes another in one migration`,
    async () => {
      await withSeeded(async (storage) => {
        const code = release({ gate: "gateCode", contract: null, links: true })
        const migration = defineMigration("job-gate-code", code.Job)
          .renameProperty("gate", "gateCode")
          .removeProperty("contract")

        await deploy(storage, code.ontology, [migration])

        expect((await object(storage, "j-1"))?.properties).toEqual({
          id: "j-1",
          gateCode: "A1",
          note: "first",
          temperature: 21.5,
        })
        const holders = await storage.objects.listArtifactHolders?.({
          projectId: PROJECT,
          artifactId: ARTIFACT,
          limit: 10,
        })
        expect(holders?.holders ?? []).toEqual([])
      })
    },
    TIMEOUT_MS
  )

  // Removal proofs: leave the dry run out of `applyTypeShapes`, and the duplicate fails after the
  // point of no return, with every job already renamed; leave out the preparation after the run,
  // and `gateCode` has no values; in PostgreSQL, read `listByPrimaryIdPage` with `*`, and the dry
  // run fails on its cached plan once query preparation added a column to `objects`.
  test(
    `${name} builds a newly unique renamed property after the run, refusing duplicates before it`,
    async () => {
      await withSeeded(async (storage) => {
        // A release where `gate` isn't unique: its values go, and two jobs may share one.
        const plain = release({
          gate: "gate",
          contract: "contract",
          links: true,
          uniqueGate: false,
        })
        await deploy(storage, plain.ontology)
        await firstRelease(storage, plain)
          .objects(plain.Job)
          .upsert({ properties: { id: "j-2", gate: "A1" } })
        const before = await dumpStores(storage)

        const failed = await deploy(storage, renamed.ontology, [renameGate]).catch(
          (error: unknown) => error
        )
        expect(String(failed)).toContain("Cannot make 'MigrationJob.gateCode' unique")
        expect(await dumpStores(storage)).toEqual(before)

        await firstRelease(storage, plain)
          .objects(plain.Job)
          .upsert({ properties: { id: "j-2", gate: "A2" } })
        await deploy(storage, renamed.ontology, [renameGate])
        await expectUniqueMoved(storage)
      })
    },
    TIMEOUT_MS
  )

  // Removal proof: in a provider's derived lane, clear a rename's new id only when values move
  // there; the stale preparation is trusted after the run, and nothing finds `j-1` by `A1`.
  test(
    `${name} builds a renamed property's values over a preparation no object backed`,
    async () => {
      await withSeeded(async (storage) => {
        const prepared = await storage.ontology.uniqueValues.listPrepared({ projectId: PROJECT })
        const gate = prepared.find(
          (property) => property.objectTypeId === JOB && property.propertyId === "gate"
        )!

        // `gate` stops being unique, and a release that made `gateCode` unique while no object
        // held it left its preparation, as one that recorded no shapes may have.
        const plain = release({
          gate: "gate",
          contract: "contract",
          links: true,
          uniqueGate: false,
        })
        await deploy(storage, plain.ontology)
        await storage.transaction(async (tx) => {
          await tx.ontology.uniqueValues.lockPreparation({ projectId: PROJECT })
          await tx.ontology.uniqueValues.markPrepared({
            ...gate,
            projectId: PROJECT,
            propertyId: "gateCode",
            preparedAt: "2026-04-01T00:00:00.000Z",
          })
        })

        // A crash right past the point of no return: the deploy that resumes the run no longer
        // knows a rename ran, so the run itself has to have cleared `gateCode`.
        const crashing = deploy(failingAfter(storage, 0), renamed.ontology, [renameGate])
        const crashed = await crashing.catch((error: unknown) => error)
        expect(String(crashed)).toContain("the process was killed")

        await deploy(storage, renamed.ontology, [renameGate])
        await expectUniqueMoved(storage)
      })
    },
    TIMEOUT_MS
  )

  // Removal proof: in a provider's derived lane, drop the unique values of a moved rename instead
  // of moving them; nothing builds them again here.
  test(
    `${name} resumes a rename a crash stopped, and moves each key once`,
    async () => {
      await withSeeded(async (storage) => {
        const before = await versions(storage)
        const options = { batchRows: 2, migrations: [renameGate], ontology: renamed.ontology }
        const crashed = await migrate(failingAfter(storage, 3), options).catch(
          (error: unknown) => error
        )
        expect(String(crashed)).toContain("Run `sixb db migrate` to resume it.")

        const resumed = await resumeOntologyMigration({ storage, projectId: PROJECT, batchRows: 2 })
        expect(resumed?.status).toBe("applied")
        await expectVersionsBumpedOnce(storage, before)

        const jobs = await readJobs(storage)
        expect(jobs.get("j-1")?.effective?.properties.gateCode).toBe("A1")
        expect(jobs.get("p-2")?.override?.value).toEqual({
          kind: "patch",
          set: {},
          unset: ["gateCode", "note"],
        })
        await expectUniqueMoved(storage)
      })
    },
    TIMEOUT_MS
  )
}

/** A whole deploy step, as `sixb db migrate` runs it: unique and query preparation included. */
function deploy(
  storage: Storage,
  ontology: OntologyRegistry,
  migrations: readonly MigrationDefinition[] = []
) {
  return migrateStorage(storage, {
    projectId: PROJECT,
    ontology,
    migrations,
    ontologyShapes: "deploy",
  })
}

/** The queued indexing of a job's `gates` profile, as the dispatcher reads it. */
async function queuedIndexing(storage: Storage, primaryId: string) {
  const due = await storage.ontology.vectorIndexing?.listDue({
    projectId: PROJECT,
    now: "2100-01-01T00:00:00.000Z",
    limit: 100,
  })
  return due?.find((work) => work.ref.primaryId === primaryId && work.profile === "gates")
}

/** The stored state of the jobs the cases read, by primary id. */
async function readJobs(storage: Storage) {
  const refs = [...["j-1", "p-1", "p-2", "p-3"].map((id) => jobRef(id)), jobRef("i-1", INSPECTION)]
  const state = await storage.ontology.materializations.readState({
    projectId: PROJECT,
    objects: refs,
    links: [],
    linkScopes: [],
  })
  return new Map(state.objects.map((row) => [row.ref.primaryId, row]))
}

/**
 * `gateCode`'s values are found under it: a lookup by value finds `j-1`, another job can't take
 * its value, and once `j-1` changes it, it is free.
 */
async function expectUniqueMoved(storage: Storage): Promise<void> {
  const jobs = firstRelease(storage, renamed).objects(renamed.Job)
  const held = { projectId: PROJECT, objectTypeId: JOB, propertyId: "gateCode", valueKey: "A1" }
  expect((await storage.objects.getByUniqueValue(held))?.primaryId).toBe("j-1")

  const taken = await jobs
    .upsert({ properties: { id: "j-new", gateCode: "A1" } })
    .catch((error: unknown) => error)
  expect(String(taken)).toContain("already has this 'gateCode'")

  await jobs.upsert({ properties: { id: "j-1", gateCode: "A9" } })
  await jobs.upsert({ properties: { id: "j-new", gateCode: "A1" } })
}

/** The deploy's ontology step, with a batch size of the test's. */
async function migrate(
  storage: Storage,
  options: {
    readonly batchRows?: number
    readonly migrations?: readonly MigrationDefinition[]
    readonly ontology?: OntologyRegistry
  } = {}
) {
  const migrations = options.migrations ?? [removeGate]
  const ontology = options.ontology ?? v2.ontology
  const shapes = await check(storage, "deploy", ontology, migrations)
  if (shapes.blocked) throw new TypeShapeMismatchError(shapes)

  const run = await applyOntologyMigrations({
    storage,
    projectId: PROJECT,
    ontology,
    migrations,
    check: shapes,
    ...(options.batchRows ? { batchRows: options.batchRows } : {}),
  })
  await recordTypeShapes(storage, shapes)
  return run
}

function check(
  storage: Storage,
  mode: "check" | "deploy" | "role",
  ontology: OntologyRegistry = v2.ontology,
  migrations: readonly MigrationDefinition[] = [removeGate]
) {
  return checkTypeShapes({ storage, projectId: PROJECT, ontology, migrations, mode })
}

/** `storage`, whose migration batches fail once `batches` of them applied. */
function failingAfter<TStorage extends Storage>(storage: TStorage, batches: number): TStorage {
  const migrations = storage.ontology.migrations!
  let applied = 0
  const failing: OntologyMigrationStorage = {
    parallelism: migrations.parallelism,
    getOpenRun: (input) => migrations.getOpenRun(input),
    listSettled: (input) => migrations.listSettled(input),
    settle: (input) => migrations.settle(input),
    startRun: (input) => migrations.startRun(input),
    finishRun: (input) => migrations.finishRun(input),
    async applyBatch(input) {
      if (applied === batches) throw new Error("the process was killed")
      applied += 1
      return migrations.applyBatch(input)
    },
  }

  const ontology = new Proxy(storage.ontology, {
    get: (target, key) => (key === "migrations" ? failing : Reflect.get(target, key)),
  })
  return new Proxy(storage, {
    get(target, key) {
      if (key === "ontology") return ontology
      const value = Reflect.get(target, key)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function object(storage: Storage, primaryId: string, objectTypeId: string = JOB) {
  return storage.objects.getByPrimaryId({ projectId: PROJECT, ...jobRef(primaryId, objectTypeId) })
}

/** Each job's and inspection's version, and whether its row holds a removed key. */
async function versions(storage: Storage) {
  const rows = new Map<string, { readonly version: number; readonly holds: boolean }>()
  for (const objectTypeId of [JOB, INSPECTION]) {
    const page = await storage.objects.listByPrimaryIdPage({
      projectId: PROJECT,
      objectTypeId,
      limit: 100,
    })
    for (const row of page.objects) {
      const holds = "gate" in row.properties || "contract" in row.properties
      rows.set(row.primaryId, { version: row.version, holds })
    }
  }
  return rows
}

/** Every object whose row held a removed key went one version up, and only those. */
async function expectVersionsBumpedOnce(
  storage: Storage,
  before: Awaited<ReturnType<typeof versions>>
): Promise<void> {
  const after = await versions(storage)
  for (const [id, row] of before) {
    expect({ id, version: after.get(id)?.version }).toEqual({
      id,
      version: row.version + (row.holds ? 1 : 0),
    })
  }
}
