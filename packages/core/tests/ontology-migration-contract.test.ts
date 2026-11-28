import { afterEach, describe, expect, test } from "bun:test"
import { InMemoryStorage, migrateStorage } from "../src"
import { applyTypeShapes } from "../src/storage/migrations/migrate-storage"
import type { ObjectQueryPreparationResult } from "../src/storage/objects/query-preparation"
import { runOntologyMigrationContractSuite } from "../src/testing/ontology-migration-contract"
import {
  closeReleases,
  JOB,
  PROJECT,
  renamed,
  renameGate,
  seedJobs,
  v1,
} from "../src/testing/ontology-migration-contract-fixture"

runOntologyMigrationContractSuite("in-memory", {
  createStorage: () => new InMemoryStorage(),
})

// Removal proof: in `migrateStorage`, prepare query indexes whatever the check found; the rename's
// deploy then prepares them once while `j-1` still holds `gate`, before the run's first batch.
describe("query indexes around a migration run", () => {
  let storage: InMemoryStorage | undefined

  afterEach(async () => {
    if (storage) await closeReleases(storage)
    storage = undefined
  })

  /** Seeded jobs, whose query preparation says which key `j-1` holds each time it runs. */
  async function observedStorage() {
    const seeded = new InMemoryStorage()
    storage = seeded
    await seedJobs(seeded)

    const prepared: string[] = []
    const observed = Object.assign(seeded, {
      async prepareObjectQueries(): Promise<ObjectQueryPreparationResult> {
        const job = await seeded.objects.getByPrimaryId({
          projectId: PROJECT,
          objectTypeId: JOB,
          primaryId: "j-1",
        })
        prepared.push("gate" in (job?.properties ?? {}) ? "gate" : "gateCode")
        return { status: "current", objectTypes: 0, indexes: 0, warnings: [] }
      },
    })
    return { storage: observed, prepared }
  }

  const options = { projectId: PROJECT, ontology: renamed.ontology, migrations: [renameGate] }

  for (const mode of ["deploy", "dev"] as const) {
    test(`are prepared after the run, not before it (${mode})`, async () => {
      const { storage, prepared } = await observedStorage()

      await migrateStorage(storage, { ...options, ontologyShapes: mode })

      expect(prepared).toEqual(["gateCode"])
    })
  }

  test("are prepared after the run `sixb check --migrate` applies", async () => {
    const { storage, prepared } = await observedStorage()

    const checked = await migrateStorage(storage, { ...options, ontologyShapes: "check" })
    expect(prepared).toEqual([])

    await applyTypeShapes(storage, options, checked.shapes!)
    expect(prepared).toEqual(["gateCode"])
  })

  test("are prepared before anything else when there is no run", async () => {
    const { storage, prepared } = await observedStorage()

    await migrateStorage(storage, {
      projectId: PROJECT,
      ontology: v1.ontology,
      ontologyShapes: "deploy",
    })

    expect(prepared).toEqual(["gate"])
  })
})
