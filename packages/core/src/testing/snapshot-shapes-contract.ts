import { expect, test } from "bun:test"
import {
  can,
  defineGroup,
  defineMarking,
  defineMigration,
  defineObjectType,
  defineRole,
  link,
  OntologyRegistry,
  prop,
  resolveAuthorizationContext,
  SixbHost,
} from ".."
import { InMemoryBlobStorage } from "../blob-storage"
import { InMemoryBroker } from "../broker"
import { createTestingScope } from "../execution/scopes"
import { InMemoryLakeStorage } from "../lake-storage"
import type { MigrationDefinition } from "../migrations/types"
import { typeShape } from "../ontology/type-shapes"
import { InMemoryQueues } from "../queues"
import { exportSnapshot, hostSnapshotSource } from "../snapshots/export"
import { encodeSnapshotFrame, SNAPSHOT_SIGNATURE, type SnapshotRecord } from "../snapshots/format"
import { importSnapshot, type SnapshotImportReport } from "../snapshots/import"
import { migrateStorage } from "../storage/migrations"
import { formatTypeShapeFindings } from "../storage/migrations/type-shape-messages"
import { checkTypeShapes } from "../storage/migrations/type-shapes"
import type { BranchNamespaceStorage, SnapshotLoadStorage } from "../storage/snapshots"
import type { Storage } from "../storage/types"
import { createTestSixb } from "./execution"

// Jobs as production stores them, with their shapes recorded by a deploy: `gate` and `hours` are
// strings, and `note` is internal, so a clerk's copy holds none of it. Each branch changes them as
// a release would, with or without the migration that makes production's objects fit, and its
// copy must say what a deploy of the same code to production says: the branch is its dry run.

const PROJECT = "snapshot-shapes"
const TIMEOUT_MS = 30_000

const internal = defineMarking("snapshot-job-internal")

const id = () => prop("id", "string", { primary: true, required: true })
const note = () => prop("note", "string", { markings: [internal] })
/** Queryable, so a role's view condition can read it. */
const hours = () => prop("hours", "string", { query: { searchable: true, filterable: true } })

const Crew = defineObjectType({
  id: "SnapshotCrew",
  name: "Crew",
  properties: [id(), prop("name", "string"), prop("nickname", "string")],
})

const crew = () => link("crew", Crew)

const Job = defineObjectType({
  id: "SnapshotJob",
  name: "Job",
  properties: [id(), prop("gate", "string"), hours(), note()],
  links: [crew()],
})

/** Settled by production's first deploy: it never runs again, there or on a branch. */
const legacy = defineMigration("job-legacy", Job).removeProperty("legacy")

/** Jobs as a branch changes them, with their crew. */
const job = (...properties: ReturnType<typeof prop>[]) =>
  defineObjectType({ id: Job.id, name: "Job", properties: [id(), ...properties], links: [crew()] })

const roles = [
  defineRole("snapshot-job-owner", {
    grantedTo: [defineGroup("owners")],
    grants: [can.view([Job, Crew])],
    clearances: [internal],
  }),
  defineRole("snapshot-job-clerk", {
    grantedTo: [defineGroup("clerks")],
    grants: [can.view([Job, Crew])],
  }),
  defineRole("snapshot-job-scheduler", {
    grantedTo: [defineGroup("schedulers")],
    grants: [can.view(Job).where((job) => job.p.hours.eq("3")), can.view(Crew)],
  }),
]

type ContractStorage = Storage & SnapshotLoadStorage & BranchNamespaceStorage
type OntologySources = NonNullable<ConstructorParameters<typeof OntologyRegistry>[0]>["sources"]

function hostOf(storage: Storage, types: OntologySources): SixbHost {
  return new SixbHost({
    id: PROJECT,
    ontology: types,
    markings: [internal],
    groups: [defineGroup("owners"), defineGroup("clerks"), defineGroup("schedulers")],
    roles,
    blobStorage: new InMemoryBlobStorage(),
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    queues: new InMemoryQueues(),
    storage,
  })
}

/**
 * A deploy recorded the shapes, then actions created the jobs and the crew. With `recorded:
 * false`, production never ran the gate: its objects fit no recorded shape.
 */
async function production(storage: Storage, options: { readonly recorded?: boolean } = {}) {
  if (options.recorded !== false) {
    await migrateStorage(storage, {
      projectId: PROJECT,
      ontology: new OntologyRegistry({ sources: [Job, Crew] }),
      migrations: [legacy],
      ontologyShapes: "deploy",
    })
  }

  const host = hostOf(storage, [Job, Crew])
  const trusted = createTestSixb(host)
  for (const properties of [
    { id: "j1", gate: "B12", hours: "3", note: "call first" },
    { id: "j2", gate: "C3", hours: "5" },
    { id: "j3", hours: "1" },
  ]) {
    await trusted.objects(Job).upsert({ properties })
  }
  await trusted.objects(Crew).upsert({ properties: { id: "k1", name: "Ada", nickname: "A" } })
  await trusted.objects(Job).byId("j1").link(Job.l.crew, { objectTypeId: Crew.id, primaryId: "k1" })

  for (const [userId, group] of [
    ["usr_alice", "owners"],
    ["usr_bob", "clerks"],
    ["usr_cy", "schedulers"],
  ] as const) {
    await storage.auth?.users.create({ projectId: PROJECT, id: userId, email: `${userId}@x.test` })
    await storage.auth?.groupMemberships.upsert({
      projectId: PROJECT,
      userId,
      groupId: group,
      source: "manual",
    })
  }

  return host
}

/**
 * The copy Alice (everything) or Bob (no `note`) takes, loaded into a branch running `types`, and
 * what a deploy of the same code to production finds: its gate in `check` mode, which writes
 * nothing.
 */
async function branchOf(input: {
  readonly storage: ContractStorage
  readonly host: SixbHost
  /** Alice reads everything, Bob no `note`, Cy only the jobs of 3 hours. */
  readonly as: "owners" | "clerks" | "schedulers"
  readonly types: OntologySources
  readonly migrations?: readonly MigrationDefinition[]
}) {
  const userId = { owners: "usr_alice", clerks: "usr_bob", schedulers: "usr_cy" }[input.as]
  const scope = createTestingScope({
    projectId: PROJECT,
    context: resolveAuthorizationContext({
      principal: { type: "user", id: userId },
      groupIds: [input.as],
      roles: input.host.definitions.security.listResolvedRoles(),
    }),
  })

  const branch = await input.storage.createBranchNamespace(`shapes-${input.as}`)
  const ontology = new OntologyRegistry({ sources: input.types })
  const migrations = input.migrations ?? []
  // Taken once, as a spool holds it: the import reads it again when it loads without a type it
  // refuses, and refuses a copy read again that isn't the same one.
  const chunks: Uint8Array[] = []
  for await (const chunk of exportSnapshot(hostSnapshotSource(input.host), {
    scope,
    pageSize: 1,
  })) {
    chunks.push(chunk)
  }
  const report = await importSnapshot({
    snapshot: async function* () {
      yield* chunks
    },
    storage: branch,
    ontology,
    migrations,
  })

  const deploy = await checkTypeShapes({
    storage: input.storage,
    projectId: PROJECT,
    ontology,
    migrations,
    mode: "check",
    uniqueDuplicates: true,
  })
  const deployRefuses = Object.fromEntries(
    deploy.types.flatMap((type) =>
      type.findings.length > 0
        ? [[type.objectTypeId, formatTypeShapeFindings(type.findings)] as const]
        : []
    )
  )

  return { branch, ontology, report, deployRefuses }
}

/** What the branch says a deploy refuses: the types it left out for it, and the keys it dropped. */
function branchRefuses(report: SnapshotImportReport): Record<string, readonly string[]> {
  return Object.fromEntries([
    ...report.skipped.flatMap((skip) =>
      skip.findings.length > 0 ? [[skip.objectTypeId, skip.findings] as const] : []
    ),
    ...report.types.flatMap((type) =>
      type.refusedByDeploy.length > 0 ? [[type.objectTypeId, type.refusedByDeploy] as const] : []
    ),
  ])
}

/** A stored object's own properties, as the branch holds them. */
async function stored(storage: Storage, objectTypeId: string, primaryId: string) {
  const row = await storage.objects.getByPrimaryId({ projectId: PROJECT, objectTypeId, primaryId })
  return row?.properties
}

async function shapesOf(storage: Storage) {
  const rows = await storage.ontology.typeShapes.list({ projectId: PROJECT })
  return Object.fromEntries(rows.map((row) => [row.objectTypeId, [row.state, row.shape]]))
}

/**
 * The branch's migrations, on what a copy holds: production's shapes travel with it, and the
 * branch decides each case as a deploy of the same code to production does.
 */
export function runSnapshotShapesCases(
  name: string,
  withStorage: (run: (storage: ContractStorage) => Promise<void>) => Promise<void>
): void {
  // Red check: in export.ts, leave `recordedShapes` empty: the shapes travel as `unrecorded`, and
  // the settled migration is lost on the branch.
  test(
    `${name} carries production's shapes and settled migrations into a branch`,
    async () => {
      await withStorage(async (storage) => {
        const host = await production(storage)
        const { branch, report, deployRefuses } = await branchOf({
          storage,
          host,
          as: "owners",
          types: [Job, Crew],
          migrations: [legacy],
        })

        expect(report.skipped).toEqual([])
        expect(branchRefuses(report)).toEqual(deployRefuses)
        expect(await shapesOf(branch)).toEqual(await shapesOf(storage))
        expect(await branch.ontology.migrations?.listSettled({ projectId: PROJECT })).toEqual([
          { objectTypeId: Job.id, migrationId: "job-legacy" },
        ])

        await host.closeBroker()
      })
    },
    TIMEOUT_MS
  )

  // Red checks: in definitions.ts, make `keeps` return `code.properties[id] !== undefined` only:
  // `gate` is left out before the rename can move it. In import.ts, drop the `applyTypeShapes`
  // call: `gate` stays, and the branch's shape is production's.
  test(
    `${name} applies the branch's pending rename to production's objects`,
    async () => {
      await withStorage(async (storage) => {
        const host = await production(storage)
        const Renamed = job(prop("gateCode", "string"), hours(), note())
        const rename = defineMigration("job-gate-code", Renamed).renameProperty("gate", "gateCode")

        const { branch, ontology, report, deployRefuses } = await branchOf({
          storage,
          host,
          as: "owners",
          types: [Renamed, Crew],
          migrations: [rename],
        })

        expect(deployRefuses).toEqual({})
        expect(branchRefuses(report)).toEqual(deployRefuses)
        expect(report.types).toEqual([
          expect.objectContaining({ objectTypeId: Crew.id, migrationIds: [] }),
          expect.objectContaining({
            objectTypeId: Job.id,
            objects: 3,
            migrationIds: ["job-gate-code"],
            droppedPropertyIds: [],
          }),
        ])
        expect(await stored(branch, Job.id, "j1")).toEqual({
          id: "j1",
          gateCode: "B12",
          hours: "3",
          note: "call first",
        })
        expect(await stored(branch, Job.id, "j3")).toEqual({ id: "j3", hours: "1" })
        expect((await shapesOf(branch))[Job.id]).toEqual(["current", typeShape(Renamed, ontology)])

        // The edits moved too: a write on the branch validates against the renamed objects.
        const onBranch = createTestSixb(hostOf(branch, [Renamed, Crew]))
        await onBranch.objects(Renamed).upsert({ properties: { id: "j2", hours: "6" } })
        expect((await onBranch.objects(Renamed).byId("j2").get())?.properties).toEqual({
          id: "j2",
          gateCode: "C3",
          hours: "6",
        })

        // Production is untouched.
        expect(await stored(storage, Job.id, "j1")).toMatchObject({ gate: "B12" })
        await host.closeBroker()
      })
    },
    TIMEOUT_MS
  )

  // Red check: in definitions.ts, skip the type when `classes.missing` holds a change that isn't
  // a removal, as the shapes alone would: the jobs are left out for a migration nobody needs.
  test(
    `${name} loads a narrowing production's objects already fit, as a deploy passes it`,
    async () => {
      await withStorage(async (storage) => {
        const host = await production(storage)
        const Required = job(
          prop("gate", "string"),
          prop("hours", "string", {
            required: true,
            query: { searchable: true, filterable: true },
          }),
          note()
        )

        const { report, deployRefuses } = await branchOf({
          storage,
          host,
          as: "owners",
          types: [Required, Crew],
        })

        expect(deployRefuses).toEqual({})
        expect(branchRefuses(report)).toEqual({})
        expect(report.skipped).toEqual([])
        expect(report.types).toContainEqual(
          expect.objectContaining({ objectTypeId: Job.id, objects: 3 })
        )

        await host.closeBroker()
      })
    },
    TIMEOUT_MS
  )

  // Red checks: in import.ts, return no `refusedTypes`: the jobs load with string hours under a
  // double. Count nothing in `heldProperties`: the crew's nickname goes without a word. Leave
  // `unloadSnapshot` empty: the second load is refused, the namespace holding objects already.
  test(
    `${name} refuses what a deploy refuses, with its lines, and leaves out what the branch removed`,
    async () => {
      await withStorage(async (storage) => {
        const host = await production(storage)
        const Retyped = job(prop("gate", "string"), prop("hours", "double"), note())
        const Renamed = defineObjectType({
          id: Crew.id,
          name: "Crew",
          properties: [id(), prop("name", "string")],
        })

        const { branch, report, deployRefuses } = await branchOf({
          storage,
          host,
          as: "owners",
          types: [Retyped, Renamed],
        })

        expect(branchRefuses(report)).toEqual(deployRefuses)
        expect(deployRefuses).toEqual({
          [Job.id]: [
            "✗ SnapshotJob: 'hours' changed from string to double, and 3 objects hold edits it no longer accepts.",
            "  Convert them in a migration:",
            '    defineMigration("snapshot-job-hours", SnapshotJob).convertProperty("hours", ({ value }) => …)',
          ],
          [Crew.id]: [
            "✗ SnapshotCrew: 'nickname' was removed, and 1 object holds it.",
            "  Rename or remove it in a migration:",
            '    defineMigration("snapshot-crew-nickname", SnapshotCrew).renameProperty("nickname", "<new id>")',
            '    defineMigration("snapshot-crew-nickname", SnapshotCrew).removeProperty("nickname")',
          ],
        })
        expect(report.skipped).toEqual([
          expect.objectContaining({ objectTypeId: Job.id, kind: "unfit" }),
        ])
        expect(await stored(branch, Job.id, "j1")).toBeUndefined()

        // A removed property is left out of the objects, so the type stays useful on the branch.
        expect(report.types).toEqual([
          expect.objectContaining({
            objectTypeId: Crew.id,
            objects: 1,
            droppedPropertyIds: ["nickname"],
          }),
        ])
        expect(await stored(branch, Crew.id, "k1")).toEqual({ id: "k1", name: "Ada" })

        await host.closeBroker()
      })
    },
    TIMEOUT_MS
  )

  // Red check: in import.ts, count nothing in `holdsRemovedType`: the crew is skipped without
  // the line a deploy prints.
  test(
    `${name} says a deploy refuses to remove a type that holds objects`,
    async () => {
      await withStorage(async (storage) => {
        const host = await production(storage)
        const { report, deployRefuses } = await branchOf({
          storage,
          host,
          as: "owners",
          types: [Job],
        })

        expect(branchRefuses(report)).toEqual(deployRefuses)
        expect(report.skipped).toEqual([
          {
            objectTypeId: Crew.id,
            kind: "removed",
            reason: "the branch no longer defines this type",
            findings: [
              "✗ SnapshotCrew was removed, and 1 object holds it.",
              "  Removing a type that holds objects isn't supported yet: declare it again.",
            ],
          },
        ])

        await host.closeBroker()
      })
    },
    TIMEOUT_MS
  )

  // Red check: in definitions.ts, return `recorded` for an `unrecorded` shape too: the branch
  // takes production's code as what its objects fit, and loads the job that lacks its hours.
  test(
    `${name} checks a type production never recorded as a first deploy would`,
    async () => {
      await withStorage(async (storage) => {
        // Production's code made `hours` required after j4 was created without it, and no deploy
        // ever recorded what its objects fit.
        const before = await production(storage, { recorded: false })
        await createTestSixb(before)
          .objects(Job)
          .upsert({ properties: { id: "j4" } })
        await before.closeBroker()
        const Required = job(
          prop("gate", "string"),
          prop("hours", "string", {
            required: true,
            query: { searchable: true, filterable: true },
          }),
          note()
        )
        const host = hostOf(storage, [Required, Crew])

        const { branch, report, deployRefuses } = await branchOf({
          storage,
          host,
          as: "owners",
          types: [Required, Crew],
        })

        expect(Object.keys(deployRefuses)).toEqual([Job.id])
        expect(branchRefuses(report)).toEqual(deployRefuses)
        expect(report.skipped).toEqual([
          expect.objectContaining({ objectTypeId: Job.id, kind: "unfit" }),
        ])
        expect((await shapesOf(branch))[Job.id]?.[0]).not.toBe("migrating")

        await host.closeBroker()
      })
    },
    TIMEOUT_MS
  )

  // Red checks: in import.ts, report `hiddenPropertyIds` as empty: the migration reads as having
  // covered `note`, which the copy never held. Pass no `unseen` to the gate in import.ts: the
  // jobs are refused for values the copy can't see.
  test(
    `${name} lists what the person could not read, which the migrations never saw`,
    async () => {
      await withStorage(async (storage) => {
        const host = await production(storage)
        // `note` becomes a required `remark`: only production's values can say if that fits.
        const Renamed = job(
          prop("gateCode", "string"),
          hours(),
          prop("note", "string", { markings: [internal], required: true })
        )
        const migration = defineMigration("job-v2", Renamed).renameProperty("gate", "gateCode")

        const { branch, report } = await branchOf({
          storage,
          host,
          as: "clerks",
          types: [Renamed, Crew],
          migrations: [migration],
        })

        expect(report.skipped).toEqual([])
        expect(report.types).toContainEqual(
          expect.objectContaining({
            objectTypeId: Job.id,
            hiddenPropertyIds: ["note"],
            throughCondition: false,
            migrationIds: ["job-v2"],
          })
        )
        expect(await stored(branch, Job.id, "j1")).toEqual({
          id: "j1",
          gateCode: "B12",
          hours: "3",
        })

        await host.closeBroker()
      })
    },
    TIMEOUT_MS
  )

  // Red check: in export.ts, return no `withheld` keys: the branch says nothing of `legacy`,
  // which the deploy refuses.
  test(
    `${name} says a deploy refuses a key production's code dropped and its objects still hold`,
    async () => {
      await withStorage(async (storage) => {
        // Production's code dropped `legacy` with no migration, and never ran the gate.
        const Old = job(prop("gate", "string"), hours(), note(), prop("legacy", "string"))
        const before = hostOf(storage, [Old, Crew])
        await createTestSixb(before)
          .objects(Old)
          .upsert({ properties: { id: "j9", legacy: "kept" } })
        await before.closeBroker()
        const host = await production(storage, { recorded: false })

        const { report, deployRefuses } = await branchOf({
          storage,
          host,
          as: "owners",
          types: [Job, Crew],
        })

        // The deploy counts; the branch only says the key is held, which tells nothing of what a
        // marking or a condition hid.
        expect(deployRefuses[Job.id]?.[0]).toBe(
          "✗ SnapshotJob: 'legacy' was removed, and 1 object holds it."
        )
        expect(branchRefuses(report)).toEqual({
          [Job.id]: [
            "✗ SnapshotJob: 'legacy' was removed, and objects hold it.",
            ...deployRefuses[Job.id]!.slice(1),
          ],
        })

        // Cy reads only jobs of 3 hours: `legacy` may be held by jobs she can't see, so her copy
        // says it wasn't checked instead.
        const hidden = await branchOf({ storage, host, as: "schedulers", types: [Job, Crew] })
        expect(branchRefuses(hidden.report)).toEqual({})
        expect(hidden.report.types).toContainEqual(
          expect.objectContaining({
            objectTypeId: Job.id,
            throughCondition: true,
            unchecked: [expect.stringContaining("'legacy' was removed: not checked")],
          })
        )

        // A rename of it runs in production; its values don't travel, so the branch says so.
        const Kept = job(prop("gate", "string"), hours(), note(), prop("legacyCode", "string"))
        const renamed = defineMigration("job-legacy-code", Kept).renameProperty(
          "legacy",
          "legacyCode"
        )
        const again = await branchOf({
          storage,
          host,
          as: "clerks",
          types: [Kept, Crew],
          migrations: [renamed],
        })
        expect(again.deployRefuses).toEqual({})
        expect(branchRefuses(again.report)).toEqual({})
        expect(again.report.types).toContainEqual(
          expect.objectContaining({
            objectTypeId: Job.id,
            unchecked: expect.arrayContaining([expect.stringContaining("legacy")]),
          })
        )

        await host.closeBroker()
      })
    },
    TIMEOUT_MS
  )

  // Red check: in import.ts, catch no `ValuePlanError` from the apply: the import throws, and
  // the branch has no copy at all.
  test(
    `${name} refuses a type whose fill a deploy refuses, with the plan's lines`,
    async () => {
      await withStorage(async (storage) => {
        const host = await production(storage)
        const Unique = job(
          prop("gate", "string", { required: true, unique: true }),
          hours(),
          note()
        )
        const collides = defineMigration("job-gate-fill", Unique).fillProperty("gate", () => "B12")
        const throws = defineMigration("job-gate-fill", Unique).fillProperty("gate", () => {
          throw new Error("no gate for this job")
        })

        for (const fill of [collides, throws]) {
          const { report } = await branchOf({
            storage,
            host,
            as: fill === collides ? "owners" : "clerks",
            types: [Unique, Crew],
            migrations: [fill],
          })
          const deploy = await migrateStorage(storage, {
            projectId: PROJECT,
            ontology: new OntologyRegistry({ sources: [Unique, Crew] }),
            migrations: [fill],
            ontologyShapes: "deploy",
          }).catch((error: Error) => error.message)

          const [skip] = report.skipped
          expect(skip).toMatchObject({ objectTypeId: Job.id, kind: "unfit" })
          for (const line of skip!.findings.slice(1)) expect(String(deploy)).toContain(line.trim())
          expect(report.types).toEqual([expect.objectContaining({ objectTypeId: Crew.id })])
        }
        expect(await stored(storage, Job.id, "j3")).toEqual({ id: "j3", hours: "1" })

        await host.closeBroker()
      })
    },
    TIMEOUT_MS
  )

  // Red check: in type-shapes.ts, match `unseen` on the code's id only: the jobs are refused
  // because the copy lacks `remark`, which production holds under `note`.
  test(
    `${name} keeps a type whose hidden property a rename makes required, and says it wasn't checked`,
    async () => {
      await withStorage(async (storage) => {
        const host = await production(storage)
        const Renamed = job(
          prop("gate", "string"),
          hours(),
          prop("remark", "string", { markings: [internal], required: true })
        )
        const rename = defineMigration("job-remark", Renamed).renameProperty("note", "remark")

        const { report } = await branchOf({
          storage,
          host,
          as: "clerks",
          types: [Renamed, Crew],
          migrations: [rename],
        })

        expect(report.skipped).toEqual([])
        expect(report.types).toContainEqual(
          expect.objectContaining({
            objectTypeId: Job.id,
            objects: 3,
            unchecked: expect.arrayContaining([
              expect.stringContaining("'remark' is now required"),
            ]),
          })
        )

        await host.closeBroker()
      })
    },
    TIMEOUT_MS
  )

  // Red check: in plan-values.ts, pass no `unrequired` to `validateEffectiveObject`: every job
  // fails the convert for the `note` the copy holds none of, and the type is left out.
  test(
    `${name} converts the objects of a type whose required property is hidden from the person`,
    async () => {
      await withStorage(async (storage) => {
        const host = await production(storage)
        const Converted = job(
          prop("gate", "integer"),
          hours(),
          prop("note", "string", { markings: [internal], required: true })
        )
        const convert = defineMigration("job-gate-length", Converted).convertProperty(
          "gate",
          ({ value }) => String(value).length
        )

        const { branch, report } = await branchOf({
          storage,
          host,
          as: "clerks",
          types: [Converted, Crew],
          migrations: [convert],
        })

        expect(report.skipped).toEqual([])
        expect(report.types).toContainEqual(
          expect.objectContaining({
            objectTypeId: Job.id,
            objects: 3,
            requiredHiddenPropertyIds: ["note"],
            migrationIds: ["job-gate-length"],
          })
        )
        expect(await stored(branch, Job.id, "j1")).toEqual({ id: "j1", gate: 3, hours: "3" })

        await host.closeBroker()
      })
    },
    TIMEOUT_MS
  )

  // Red check: in import.ts, drop `uniqueDuplicates` from the gate's check: the import throws
  // out of the unique preparation, and the branch holds nothing.
  test(
    `${name} refuses a type whose objects share a value the branch makes unique`,
    async () => {
      await withStorage(async (storage) => {
        const host = await production(storage)
        await createTestSixb(host)
          .objects(Job)
          .upsert({ properties: { id: "j3", gate: "B12" } })
        const Unique = job(prop("gate", "string", { unique: true }), hours(), note())

        const { branch, report, deployRefuses } = await branchOf({
          storage,
          host,
          as: "owners",
          types: [Unique, Crew],
        })

        expect(deployRefuses[Job.id]?.[0]).toContain("share a value")
        expect(branchRefuses(report)).toEqual(deployRefuses)
        expect(report.skipped).toEqual([
          expect.objectContaining({ objectTypeId: Job.id, kind: "unfit" }),
        ])
        expect(await stored(branch, Crew.id, "k1")).toBeDefined()

        // The deploy refuses it the same way, before anything is written.
        const deploy = await migrateStorage(storage, {
          projectId: PROJECT,
          ontology: new OntologyRegistry({ sources: [Unique, Crew] }),
          ontologyShapes: "deploy",
        }).catch((error: Error) => error)
        expect(String(deploy)).toContain("share a value")

        await host.closeBroker()
      })
    },
    TIMEOUT_MS
  )

  // Red check: in definitions.ts, leave `movedLinks` empty: the crew link is left out before
  // the load, and `removeLink` never runs on the branch.
  test(
    `${name} runs a pending removeLink on the links the copy holds`,
    async () => {
      await withStorage(async (storage) => {
        const host = await production(storage)
        const Unlinked = defineObjectType({
          id: Job.id,
          name: "Job",
          properties: [id(), prop("gate", "string"), hours(), note()],
        })
        const unlink = defineMigration("job-no-crew", Unlinked).removeLink("crew")

        const { branch, report, deployRefuses } = await branchOf({
          storage,
          host,
          as: "owners",
          types: [Unlinked, Crew],
          migrations: [unlink],
        })

        expect(deployRefuses).toEqual({})
        expect(branchRefuses(report)).toEqual({})
        expect(report.types).toContainEqual(
          expect.objectContaining({ objectTypeId: Job.id, migrationIds: ["job-no-crew"] })
        )
        const links = await branch.objects.listLinks({
          projectId: PROJECT,
          objectTypeId: Job.id,
          objectId: "j1",
          linkId: "crew",
        })
        expect(links).toEqual([])

        await host.closeBroker()
      })
    },
    TIMEOUT_MS
  )

  // Red check: in import.ts, return no change from `skippedChange` for `primary`: the skip says
  // nothing of the objects a deploy refuses it for.
  test(
    `${name} counts the objects of a type whose primary property changed`,
    async () => {
      await withStorage(async (storage) => {
        const host = await production(storage)
        const Rekeyed = defineObjectType({
          id: Crew.id,
          name: "Crew",
          properties: [
            prop("id", "string", { required: true }),
            prop("name", "string", { primary: true, required: true }),
            prop("nickname", "string"),
          ],
        })

        const { report, deployRefuses } = await branchOf({
          storage,
          host,
          as: "owners",
          types: [Job, Rekeyed],
        })

        expect(branchRefuses(report)).toEqual(deployRefuses)
        expect(report.skipped).toEqual([
          expect.objectContaining({ objectTypeId: Crew.id, kind: "primary" }),
        ])

        await host.closeBroker()
      })
    },
    TIMEOUT_MS
  )

  // Red checks: in import.ts, throw before `unloadSnapshot` when the copy can't be read again:
  // the branch keeps the jobs its code doesn't fit. Drop the `takenAt` check after the reload:
  // two moments of production mix. In each provider, drop the only-commit check of
  // `unloadSnapshot`: the object the branch wrote goes with the load.
  test(
    `${name} empties a load only while nothing else was written`,
    async () => {
      await withStorage(async (storage) => {
        const host = await production(storage)
        const scope = createTestingScope({
          projectId: PROJECT,
          context: resolveAuthorizationContext({
            principal: { type: "user", id: "usr_alice" },
            groupIds: ["owners"],
            roles: host.definitions.security.listResolvedRoles(),
          }),
        })
        const Retyped = job(prop("gate", "string"), prop("hours", "double"), note())

        // Bytes that can't be read again: the import empties what it loaded, then says why.
        const once = await storage.createBranchNamespace("read-once")
        const refused = await importSnapshot({
          snapshot: exportSnapshot(hostSnapshotSource(host), { scope }),
          storage: once,
          ontology: new OntologyRegistry({ sources: [Retyped, Crew] }),
        }).catch((error: Error) => error)
        expect(String(refused)).toContain("can't be read again")
        expect((await once.objects.list({ projectId: PROJECT })).total).toBe(0)

        // A copy read again must be the same one: a second export is another moment of production.
        const twice = await storage.createBranchNamespace("read-twice")
        const mismatched = await importSnapshot({
          snapshot: () => exportSnapshot(hostSnapshotSource(host), { scope }),
          storage: twice,
          ontology: new OntologyRegistry({ sources: [Retyped, Crew] }),
        }).catch((error: Error) => error)
        expect(String(mismatched)).toContain("is not the one loaded first")

        // A branch that took a write keeps it: emptying the load would take it too.
        const written = await storage.createBranchNamespace("written")
        const report = await importSnapshot({
          snapshot: exportSnapshot(hostSnapshotSource(host), { scope }),
          storage: written,
          ontology: new OntologyRegistry({ sources: [Job, Crew] }),
        })
        await createTestSixb(hostOf(written, [Job, Crew]))
          .objects(Job)
          .upsert({ properties: { id: "j8", hours: "2" } })

        const emptied = await written
          .unloadSnapshot({ projectId: PROJECT, commitId: report.commitId })
          .catch((error: Error) => error)
        expect(String(emptied)).toContain("something was written since")
        const unknown = await written
          .unloadSnapshot({ projectId: PROJECT, commitId: "snapshot_unknown" })
          .catch((error: Error) => error)
        expect(String(unknown)).toContain("holds no load")
        expect(await stored(written, Job.id, "j8")).toBeDefined()

        await host.closeBroker()
      })
    },
    TIMEOUT_MS
  )

  // Red checks: in format.ts, read format 3 only: the snapshot is refused. In definitions.ts,
  // keep only the declared properties of a snapshot without shapes: `gate` is left out, and the
  // first deploy's pass finds nothing to rename. In import.ts, return no `refusedTypes`: the
  // crew loads with a string where its code wants a number.
  test(
    `${name} reads an older snapshot without shapes as a first deploy does`,
    async () => {
      await withStorage(async (storage) => {
        const Renamed = job(prop("gateCode", "string"), hours())
        const Retyped = defineObjectType({
          id: Crew.id,
          name: "Crew",
          properties: [id(), prop("name", "string"), prop("nickname", "integer")],
        })
        const rename = defineMigration("job-gate-code", Renamed).renameProperty("gate", "gateCode")
        const branch = await storage.createBranchNamespace("format-2")
        const ontology = new OntologyRegistry({ sources: [Renamed, Retyped] })

        const report = await importSnapshot({
          snapshot: formatTwoSnapshot,
          storage: branch,
          ontology,
          migrations: [rename],
        })

        expect(report.skipped).toEqual([
          expect.objectContaining({ objectTypeId: Crew.id, kind: "unfit" }),
        ])
        expect(report.skipped[0]?.findings[0]).toContain("'nickname'")
        expect(report.types).toEqual([
          expect.objectContaining({
            objectTypeId: Job.id,
            objects: 2,
            migrationIds: ["job-gate-code"],
          }),
        ])
        expect(await stored(branch, Job.id, "j1")).toEqual({ id: "j1", gateCode: "B12" })
        expect(await stored(branch, Crew.id, "k1")).toBeUndefined()
        expect((await shapesOf(branch))[Job.id]).toEqual(["current", typeShape(Renamed, ontology)])
      })
    },
    TIMEOUT_MS
  )
}

/** A snapshot an earlier Sixb took: its manifest fingerprints each definition, with no shape. */
async function* formatTwoSnapshot(): AsyncGenerator<Uint8Array> {
  const at = Date.parse("2026-01-01T00:00:00.000Z")
  const fingerprinted = (objectTypeId: string) => ({
    objectTypeId,
    primaryPropertyId: "id",
    properties: { id: "fingerprint" },
    requiredPropertyIds: ["id"],
    uniquePropertyIds: [],
    links: {},
    hiddenPropertyIds: [],
    throughCondition: false,
    vectors: [],
  })
  const records = [
    {
      kind: "manifest",
      format: 2,
      projectId: PROJECT,
      takenAt: "2026-01-01T00:00:00.000Z",
      takenBy: { type: "user", id: "usr_alice" },
      members: "self",
      types: [fingerprinted(Crew.id), fingerprinted(Job.id)],
      unreadableTypeIds: [],
    },
    { kind: "members", users: [], memberships: [] },
    {
      kind: "objects",
      objectTypeId: Job.id,
      ids: ["j1", "j2"],
      createdAt: [at, at],
      updatedAt: [at, at],
      columns: [
        { propertyId: "id", values: ["j1", "j2"] },
        { propertyId: "gate", values: ["B12"], rows: [0] },
      ],
    },
    {
      kind: "objects",
      objectTypeId: Crew.id,
      ids: ["k1"],
      createdAt: [at],
      updatedAt: [at],
      columns: [
        { propertyId: "id", values: ["k1"] },
        { propertyId: "nickname", values: ["A"] },
      ],
    },
    {
      kind: "end",
      counts: { objects: 3, links: 0, points: 0, vectors: 0, users: 0, sourceRoots: 0, edits: 0 },
    },
  ] as unknown as SnapshotRecord[]

  yield new Uint8Array([...SNAPSHOT_SIGNATURE.subarray(0, -1), 2])
  for (const record of records) yield await encodeSnapshotFrame(record, { compress: false })
}
