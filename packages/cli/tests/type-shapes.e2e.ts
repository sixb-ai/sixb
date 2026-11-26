import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  prop,
  SixbHost,
} from "@sixb/core"
import { createTestSixb } from "@sixb/core/testing"
import { PostgresStorage } from "@sixb/pg"
import { runCliToCompletion, startRoleUntilReadyThenStop } from "./shared/cli-process"

// A deploy against PostgreSQL, through the real CLI: `sixb db migrate --check` decides whether the
// SSH target stops the live release (exit 3), keeps it stopped for a migration run under way
// (exit 4), or fails before it stops anything (any other code); `sixb check --migrate` applies the
// pending migrations and records the new shapes last; a role refuses code the data doesn't fit, or
// a run under way; and `sixb dev` applies what is covered and warns about the rest.

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const cli = resolve(import.meta.dir, "..", "src", "index.tsx")
const entry = resolve(import.meta.dir, "fixtures", "type-shapes", "sixb.config.ts")
const COMPOSE_FILE = join(repoRoot, "storage", "pg", "docker-compose.yml")
const compose = [
  "docker",
  "compose",
  "-p",
  `sixb-cli-type-shapes-${process.pid}`,
  "-f",
  COMPOSE_FILE,
]

const CLI_TIMEOUT_MS = 60_000
/** Exit code of `sixb db migrate --check` when the services must stop first. */
const STOP_FIRST = 3
/** …and while a migration run is past its point of no return. */
const APPLYING = 4

/** A database of one's own (`SIXB_TEST_DATABASE_URL`) skips the compose file's fixed port. */
const ownDatabase = process.env.SIXB_TEST_DATABASE_URL
let databaseUrl: string

beforeAll(async () => {
  if (ownDatabase) {
    databaseUrl = ownDatabase
    return
  }

  await dockerCompose(["up", "-d", "--wait"])
  databaseUrl = "postgresql://postgres:test@127.0.0.1:54329/postgres"
}, 120_000)

afterAll(async () => {
  if (!ownDatabase) await dockerCompose(["down", "-v", "--remove-orphans"])
}, 60_000)

async function dockerCompose(args: readonly string[]): Promise<void> {
  const proc = Bun.spawn([...compose, ...args], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), 110_000)
  try {
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    if (code !== 0) throw new Error(stderr)
  } finally {
    clearTimeout(timer)
  }
}

type Release = "first" | "withNote" | "withoutGate" | "retypedGate" | "uniqueGate" | "renamed"

/** One CLI run of `release`, on the test's schema. */
function sixb(
  schema: string,
  release: Release,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {}
) {
  return runCliToCompletion({
    cmd: [process.execPath, cli, ...args, "--entry", entry],
    cwd: repoRoot,
    env: {
      DATABASE_URL: databaseUrl,
      SIXB_SHAPES_SCHEMA: schema,
      SIXB_SHAPES_RELEASE: release,
      NO_COLOR: "1",
      ...env,
    },
    timeoutMs: CLI_TIMEOUT_MS,
  })
}

/** A schema whose first release is deployed, its shapes recorded. */
async function deployedSchema(name: string): Promise<string> {
  const schema = `type_shapes_${name}_${process.pid}`
  const migrated = await sixb(schema, "first", ["db", "migrate"])
  expect(migrated.exitCode).toBe(0)
  return schema
}

/** Writes a job as the first release's actions would. */
async function createJob(schema: string, properties: Readonly<Record<string, string>>) {
  const Job = defineObjectType({
    id: "Job",
    name: "Job",
    properties: [
      prop("ref", "string", { primary: true, required: true }),
      prop("gate", "string"),
      prop("hours", "string"),
    ],
  })
  const storage = new PostgresStorage({ connectionString: databaseUrl, schemaName: schema })
  const host = new SixbHost({
    id: "cli-type-shapes",
    ontology: [Job],
    storage,
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    auth: { id: "test", kind: "dev" },
  })
  try {
    await createTestSixb(host)
      .objects(Job)
      .upsert({ properties: { ref: "J-12", ...properties } })
  } finally {
    await storage.close()
  }
}

/** The `renamed` release's `Job`, as the fixture defines it. */
const RenamedJob = defineObjectType({
  id: "Job",
  name: "Job",
  properties: [
    prop("ref", "string", { primary: true, required: true }),
    prop("gateCode", "string", {
      unique: true,
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("hours", "string"),
  ],
})

function renamedJobs(host: SixbHost) {
  return createTestSixb(host).objects(RenamedJob)
}

/** The `renamed` release's jobs, as its actions read and write them. */
async function withRenamedJobs(
  schema: string,
  run: (jobs: ReturnType<typeof renamedJobs>, storage: PostgresStorage) => Promise<void>
): Promise<void> {
  const storage = new PostgresStorage({ connectionString: databaseUrl, schemaName: schema })
  const host = new SixbHost({
    id: "cli-type-shapes",
    ontology: [RenamedJob],
    storage,
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    auth: { id: "test", kind: "dev" },
  })
  try {
    await run(renamedJobs(host), storage)
  } finally {
    await host.closeBroker()
    await storage.close()
  }
}

/** Job `J-12`'s properties, as stored. */
async function storedJob(schema: string) {
  const storage = new PostgresStorage({ connectionString: databaseUrl, schemaName: schema })
  try {
    const job = await storage.objects.getByPrimaryId({
      projectId: "cli-type-shapes",
      objectTypeId: "Job",
      primaryId: "J-12",
    })
    return job?.properties
  } finally {
    await storage.close()
  }
}

/**
 * What a deploy killed right after the point of no return leaves: a run removing `gate`, open,
 * and `Job`'s shape `migrating`.
 */
async function openRun(schema: string): Promise<void> {
  const storage = new PostgresStorage({ connectionString: databaseUrl, schemaName: schema })
  const projectId = "cli-type-shapes"
  const runId = "migration_killed"
  const operation = { type: "ontology.migrate", runId } as const
  try {
    await storage.executions.create({
      id: `kernel:${runId}`,
      projectId,
      executor: { type: "kernel", operation },
      requesterGroupIds: [],
      source: { type: "http", requestId: runId },
      correlationId: runId,
      authorizationRef: { type: "kernel", operation },
    })

    const [stored] = await storage.ontology.typeShapes.list({ projectId })
    const { gate: _gate, ...properties } = stored!.shape.properties
    await storage.transaction((tx) =>
      tx.ontology.migrations!.startRun({
        projectId,
        id: runId,
        executionId: `kernel:${runId}`,
        startedAt: "2026-04-01T00:00:00.000Z",
        plan: {
          ontologyRevision: "killed",
          migrations: [{ id: "job-gate", hash: "killed" }],
          types: [
            {
              objectTypeId: "Job",
              fromShape: stored!.shape,
              toShape: { ...stored!.shape, properties },
              steps: [{ kind: "removeProperty", propertyId: "gate", migrationId: "job-gate" }],
            },
          ],
        },
        parts: 1,
      })
    )
  } finally {
    await storage.close()
  }
}

async function storedShape(schema: string) {
  const storage = new PostgresStorage({ connectionString: databaseUrl, schemaName: schema })
  try {
    const rows = await storage.ontology.typeShapes.list({ projectId: "cli-type-shapes" })
    return rows.find((row) => row.objectTypeId === "Job")?.shape
  } finally {
    await storage.close()
  }
}

describe("sixb db migrate --check", () => {
  test(
    "exits 0 for a compatible change, and the deploy keeps serving",
    async () => {
      const schema = await deployedSchema("compatible")
      await createJob(schema, { gate: "B12" })

      const check = await sixb(schema, "withNote", ["db", "migrate", "--check"])
      expect(check.exitCode).toBe(0)
    },
    CLI_TIMEOUT_MS * 3
  )

  test(
    "exits 3 for a narrowing no data holds, so the live release stops first",
    async () => {
      const schema = await deployedSchema("narrowing")
      await createJob(schema, { hours: "3" })

      const check = await sixb(schema, "withoutGate", ["db", "migrate", "--check"])
      expect(check.exitCode).toBe(STOP_FIRST)
      expect(check.stdout).toContain("the services stop while the new shapes are recorded")
    },
    CLI_TIMEOUT_MS * 3
  )

  // Removal proof: in `diffProperty`, make `unique` added compatible; this exits 0, and the live
  // release keeps writing values another object may hold while the new one's are built.
  test(
    "exits 3 for a property made unique, so the live release stops while its values are built",
    async () => {
      const schema = await deployedSchema("unique")
      await createJob(schema, { gate: "B12" })

      const check = await sixb(schema, "uniqueGate", ["db", "migrate", "--check"])
      expect(check.exitCode).toBe(STOP_FIRST)

      const migrated = await sixb(schema, "uniqueGate", ["db", "migrate"])
      expect(migrated.exitCode).toBe(0)
      expect((await storedShape(schema))?.properties.gate).toMatchObject({ unique: true })
    },
    CLI_TIMEOUT_MS * 3
  )

  // Revert check: in `runDbMigrate`, drop `uniqueDuplicates`: this exits 3, and the deploy stops
  // the live release for a property its data can't make unique.
  test(
    "fails, not with 3, for a property made unique that two objects share a value of",
    async () => {
      const schema = await deployedSchema("duplicate")
      await createJob(schema, { gate: "B12" })
      await createJob(schema, { ref: "J-13", gate: "B12" })

      const check = await sixb(schema, "uniqueGate", ["db", "migrate", "--check"])
      expect(check.exitCode).toBe(1)
      expect(check.stdout).toContain("Job: 'gate' is now unique, and objects")
    },
    CLI_TIMEOUT_MS * 3
  )

  // Removal proof: in `runDbMigrate`, drop the exit on findings; this exits 3, and the deploy
  // stops the live release for a change it can't make.
  test(
    "fails, not with 3, for a narrowing data holds, naming the change and the count",
    async () => {
      const schema = await deployedSchema("unfit")
      await createJob(schema, { gate: "B12" })

      const check = await sixb(schema, "withoutGate", ["db", "migrate", "--check"])
      expect(check.exitCode).toBe(1)
      expect(check.stdout).toContain("✗ Job: 'gate' was removed, and 1 object holds it.")
      expect(check.stdout).toContain('defineMigration("job-gate", Job).removeProperty("gate")')
    },
    CLI_TIMEOUT_MS * 3
  )
})

describe("migrations", () => {
  test(
    "`sixb check --migrate` applies a pending removal, then records the new shape",
    async () => {
      const schema = await deployedSchema("pending")
      await createJob(schema, { gate: "B12", hours: "3" })

      const check = await sixb(schema, "withoutGate", ["db", "migrate", "--check"], {
        SIXB_SHAPES_MIGRATION: "removeGate",
      })
      expect(check.exitCode).toBe(STOP_FIRST)
      expect(check.stdout).toContain("Ontology migrations will run")

      // Removal proof: drop `onMigrationRunStarted` from `migrationOptions` in `check.ts`; no
      // marker is written, and the SSH target would start the previous release again.
      const markers = await mkdtemp(join(tmpdir(), "sixb-migration-marker-"))
      const marker = join(markers, "started")
      const deployed = await sixb(schema, "withoutGate", ["check", "--migrate"], {
        SIXB_SHAPES_MIGRATION: "removeGate",
        SIXB_MIGRATION_RUN_MARKER: marker,
      })
      expect((await readFile(marker, "utf8")).trim()).toStartWith("migration_")
      await rm(markers, { recursive: true, force: true })
      expect(deployed.exitCode).toBe(0)
      expect(deployed.stdout + deployed.stderr).toContain("The deploy only goes forward from here")
      expect(await storedJob(schema)).toEqual({ ref: "J-12", hours: "3" })
      expect(Object.keys((await storedShape(schema))?.properties ?? {})).not.toContain("gate")
    },
    CLI_TIMEOUT_MS * 3
  )

  test(
    "`sixb check` refuses a migration that can never be right, before reading storage",
    async () => {
      const checked = await sixb(`type_shapes_invalid_${process.pid}`, "withoutGate", ["check"], {
        SIXB_SHAPES_MIGRATION: "invalid",
      })
      expect(checked.exitCode).not.toBe(0)
      expect(checked.stdout + checked.stderr).toContain(
        "Migration 'job-ref' fills 'ref', the primary property of Job"
      )
    },
    CLI_TIMEOUT_MS
  )

  test(
    "`sixb check` passes over a migration the code moved past, and says it can be deleted",
    async () => {
      const schema = await deployedSchema("inert")
      const checked = await sixb(schema, "withoutGate", ["check"], {
        SIXB_SHAPES_MIGRATION: "inert",
      })
      expect(checked.exitCode).toBe(0)
      expect(checked.stdout).toContain(
        "Migration 'job-hours' removes 'hours', which Job declares again: it does nothing now"
      )
    },
    CLI_TIMEOUT_MS * 3
  )
})

describe("the deploy step", () => {
  test(
    "`sixb check --migrate` records the new shapes once every check passed",
    async () => {
      const schema = await deployedSchema("record")
      expect(Object.keys((await storedShape(schema))?.properties ?? {})).toContain("gate")

      const deployed = await sixb(schema, "withoutGate", ["check", "--migrate"])
      expect(deployed.exitCode).toBe(0)
      expect(deployed.stdout).toContain("Stored objects")
      expect(Object.keys((await storedShape(schema))?.properties ?? {})).not.toContain("gate")
    },
    CLI_TIMEOUT_MS * 3
  )

  // The rename runs end to end: `gateCode` is newly unique, so its values are built after the run,
  // from those `gate` held, once a dry run found no duplicate.
  test(
    "`sixb check --migrate` renames a property: reads, filters, sorts, unique lookups and writes",
    async () => {
      const schema = await deployedSchema("rename")
      await createJob(schema, { gate: "B12", hours: "3" })

      const deployed = await sixb(schema, "renamed", ["check", "--migrate"], {
        SIXB_SHAPES_MIGRATION: "renameGate",
      })
      expect(deployed.exitCode).toBe(0)
      expect(await storedJob(schema)).toEqual({ ref: "J-12", gateCode: "B12", hours: "3" })

      await withRenamedJobs(schema, async (jobs, storage) => {
        await jobs.upsert({ properties: { ref: "J-13", gateCode: "A7" } })

        const filtered = await jobs
          .query()
          .where((job) => job.p.gateCode.eq("B12"))
          .list()
        expect(filtered.objects.map((job) => job.primaryId)).toEqual(["J-12"])
        const sorted = await jobs.query().orderBy(RenamedJob.p.gateCode, "asc").list()
        expect(sorted.objects.map((job) => job.primaryId)).toEqual(["J-13", "J-12"])

        const held = await storage.objects.getByUniqueValue({
          projectId: "cli-type-shapes",
          objectTypeId: "Job",
          propertyId: "gateCode",
          valueKey: "B12",
        })
        expect(held?.primaryId).toBe("J-12")
        const taken = await jobs
          .upsert({ properties: { ref: "J-14", gateCode: "B12" } })
          .catch((error: unknown) => error)
        expect(String(taken)).toContain("already has this 'gateCode'")
      })

      // Revert check: in a provider's `startRun` and `finishRun`, keep `previous_shape`: the
      // release before the rename then starts on the data the run renamed.
      const rolledBack = await sixb(schema, "first", ["orchestrator", "--no-migrate"])
      expect(rolledBack.exitCode).not.toBe(0)
      expect(rolledBack.stdout + rolledBack.stderr).toContain(
        "Job: 'gateCode' was removed since its shape was recorded."
      )
    },
    CLI_TIMEOUT_MS * 4
  )

  // Removal proof: in `runCheck`, record the shapes before `probe()`; the narrowed shape is then
  // recorded although the deploy fails, and the old release restarts on a shape it doesn't fit.
  test(
    "`sixb check --migrate` records nothing when another check fails",
    async () => {
      const schema = await deployedSchema("failing")
      const before = await storedShape(schema)

      const deployed = await sixb(schema, "withoutGate", ["check", "--migrate"], {
        SIXB_SHAPES_QUEUES_DOWN: "1",
      })
      expect(deployed.exitCode).toBe(1)
      expect(await storedShape(schema)).toEqual(before)
    },
    CLI_TIMEOUT_MS * 3
  )

  test(
    "`sixb check --migrate` and `sixb db migrate` refuse data the code doesn't fit, and record nothing",
    async () => {
      const schema = await deployedSchema("refused")
      await createJob(schema, { gate: "B12" })
      const before = await storedShape(schema)

      const checked = await sixb(schema, "withoutGate", ["check", "--migrate"])
      expect(checked.exitCode).toBe(1)
      expect(checked.stdout).toContain("✗ Job: 'gate' was removed, and 1 object holds it.")

      const migrated = await sixb(schema, "withoutGate", ["db", "migrate"])
      expect(migrated.exitCode).not.toBe(0)
      expect(migrated.stdout + migrated.stderr).toContain(
        "'gate' was removed, and 1 object holds it."
      )

      expect(await storedShape(schema)).toEqual(before)
    },
    CLI_TIMEOUT_MS * 4
  )
})

describe("a migration run under way", () => {
  // Removal proof: drop the `applying` exit in `runDbMigrate`; `--check` then exits 3, and the
  // SSH target would restart the previous release after a failure.
  test(
    "exits 4 on `db migrate --check`, stops a role, and `check --migrate` finishes it",
    async () => {
      const schema = await deployedSchema("applying")
      await createJob(schema, { gate: "B12", hours: "3" })
      await openRun(schema)

      const check = await sixb(schema, "withoutGate", ["db", "migrate", "--check"])
      expect(check.exitCode).toBe(APPLYING)
      expect(check.stdout).toContain("An ontology migration is being applied")

      const role = await sixb(schema, "withoutGate", ["orchestrator", "--no-migrate"])
      expect(role.exitCode).not.toBe(0)
      expect(role.stdout + role.stderr).toContain("An ontology migration is being applied to Job.")

      // The plan is the run's: the code that resumes it declares no migration at all.
      const finished = await sixb(schema, "withoutGate", ["check", "--migrate"])
      expect(finished.exitCode).toBe(0)
      expect(finished.stdout + finished.stderr).toContain("Resuming migration run migration_killed")
      expect(await storedJob(schema)).toEqual({ ref: "J-12", hours: "3" })
      expect((await sixb(schema, "withoutGate", ["db", "migrate", "--check"])).exitCode).toBe(0)
    },
    CLI_TIMEOUT_MS * 5
  )
})

describe("a role", () => {
  // Removal proof: drop `refuseUnfitShapes` from `migrateStorageForRole`; the `--no-migrate` run
  // then starts and serves, and this times out.
  test(
    "refuses to start on code that narrows a recorded type, with or without --no-migrate",
    async () => {
      const schema = await deployedSchema("role")

      for (const args of [["orchestrator"], ["orchestrator", "--no-migrate"]]) {
        const started = await sixb(schema, "retypedGate", args)
        expect(started.exitCode).not.toBe(0)
        expect(started.stdout + started.stderr).toContain(
          "Job: 'gate' changed from string to integer since its shape was recorded."
        )
      }
    },
    CLI_TIMEOUT_MS * 3
  )
})

describe("a rolled-back release", () => {
  // Removal proof: drop `recordTypeShapes` from `refuseUnfitShapes`; the old release then serves
  // `gate` while the narrowed shape stays recorded, and the next deploy never probes for it.
  test(
    "puts back the shape it writes when it starts with --no-migrate",
    async () => {
      const schema = await deployedSchema("rollback")
      const narrowed = await sixb(schema, "withoutGate", ["db", "migrate"])
      expect(narrowed.exitCode).toBe(0)
      expect(Object.keys((await storedShape(schema))?.properties ?? {})).not.toContain("gate")

      const logs = await mkdtemp(join(tmpdir(), "sixb-type-shapes-role-"))
      try {
        const { ready } = await startRoleUntilReadyThenStop({
          cmd: [process.execPath, cli, "orchestrator", "--no-migrate", "--entry", entry],
          cwd: repoRoot,
          logPath: join(logs, "operations.log"),
          env: {
            DATABASE_URL: databaseUrl,
            SIXB_SHAPES_SCHEMA: schema,
            SIXB_SHAPES_RELEASE: "first",
          },
          timeoutMs: CLI_TIMEOUT_MS,
        })
        expect(ready).toBe(true)
      } finally {
        await rm(logs, { recursive: true, force: true })
      }

      expect(Object.keys((await storedShape(schema))?.properties ?? {})).toContain("gate")
    },
    CLI_TIMEOUT_MS * 3
  )
})

describe("the release before a deploy that only added a property", () => {
  // Revert check: in `roleCheck`, refuse every change that narrows, as before the previous release
  // was told apart: the old release then refuses the shape with `note`, and never becomes ready.
  test(
    "starts with --no-migrate, and leaves the recorded shape as it was",
    async () => {
      const schema = await deployedSchema("widened")
      expect((await sixb(schema, "withNote", ["db", "migrate"])).exitCode).toBe(0)
      const recorded = await storedShape(schema)

      const logs = await mkdtemp(join(tmpdir(), "sixb-type-shapes-widened-"))
      try {
        const { ready } = await startRoleUntilReadyThenStop({
          cmd: [process.execPath, cli, "orchestrator", "--no-migrate", "--entry", entry],
          cwd: repoRoot,
          logPath: join(logs, "operations.log"),
          env: {
            DATABASE_URL: databaseUrl,
            SIXB_SHAPES_SCHEMA: schema,
            SIXB_SHAPES_RELEASE: "first",
          },
          timeoutMs: CLI_TIMEOUT_MS,
        })
        expect(ready).toBe(true)
      } finally {
        await rm(logs, { recursive: true, force: true })
      }

      expect(await storedShape(schema)).toEqual(recorded)
    },
    CLI_TIMEOUT_MS * 3
  )
})

describe("newer code than the recorded shape", () => {
  // Revert check: in `roleCheck`, drop the `previous` test: the role then keeps `note` recorded
  // and serves before `sixb db migrate` read the objects that hold it.
  test(
    "refuses to start when it removes what the recorded shape holds",
    async () => {
      const schema = `type_shapes_newer_${process.pid}`
      expect((await sixb(schema, "withNote", ["db", "migrate"])).exitCode).toBe(0)

      const started = await sixb(schema, "first", ["orchestrator", "--no-migrate"])
      expect(started.exitCode).not.toBe(0)
      expect(started.stdout + started.stderr).toContain(
        "Job: 'note' was removed since its shape was recorded."
      )
    },
    CLI_TIMEOUT_MS * 2
  )
})

describe("sixb dev", () => {
  test(
    "applies the pending migrations on local data at startup",
    async () => {
      const schema = await deployedSchema("devapply")
      await createJob(schema, { gate: "B12", hours: "3" })

      await devOutputUntil(schema, "source rows rewritten.", {
        SIXB_SHAPES_MIGRATION: "removeGate",
      })
      expect(await storedJob(schema)).toEqual({ ref: "J-12", hours: "3" })
      expect(Object.keys((await storedShape(schema))?.properties ?? {})).not.toContain("gate")
    },
    CLI_TIMEOUT_MS * 3
  )

  test(
    "warns about data the code doesn't fit, and keeps the recorded shape",
    async () => {
      const schema = await deployedSchema("dev")
      await createJob(schema, { gate: "B12" })
      const before = await storedShape(schema)

      const output = await devOutputUntil(schema, "'gate' was removed, and 1 object holds it.")
      expect(output).toContain("The stored objects don't fit this code.")
      expect(await storedShape(schema)).toEqual(before)
    },
    CLI_TIMEOUT_MS * 3
  )
})

/** Starts `sixb dev` on the code without `gate`, and stops it once its output holds `text`. */
async function devOutputUntil(
  schema: string,
  text: string,
  env: Readonly<Record<string, string>> = {}
): Promise<string> {
  const proc = Bun.spawn([process.execPath, cli, "dev", "--entry", entry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      SIXB_SHAPES_SCHEMA: schema,
      SIXB_SHAPES_RELEASE: "withoutGate",
      NO_COLOR: "1",
      ...env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  let output = ""
  const found = Promise.withResolvers<void>()
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true })
      if (output.includes(text)) found.resolve()
    }
  }
  void read(proc.stdout)
  void read(proc.stderr)

  // The process is ours to stop, whatever the assertions do.
  const deadline = setTimeout(
    () => found.reject(new Error(`No '${text}' in:\n${output}`)),
    CLI_TIMEOUT_MS
  )
  try {
    await Promise.race([
      found.promise,
      proc.exited.then(() => {
        if (!output.includes(text)) throw new Error(`sixb dev exited first:\n${output}`)
      }),
    ])
    return output
  } finally {
    clearTimeout(deadline)
    proc.kill("SIGKILL")
    await proc.exited
  }
}
