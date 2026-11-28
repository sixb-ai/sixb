import { expect, test } from "bun:test"
import {
  col,
  defineDataset,
  defineMigration,
  defineObjectType,
  defineProjection,
  link,
  prop,
  SixbHost,
} from ".."
import { InMemoryBlobStorage } from "../blob-storage"
import { InMemoryBroker } from "../broker"
import { InMemoryLakeStorage } from "../lake-storage"
import { OntologyRegistry } from "../ontology"
import { typeShape } from "../ontology/type-shapes"
import { InMemoryQueues } from "../queues"
import { exportSnapshot, hostSnapshotSource } from "../snapshots/export"
import {
  encodeSnapshotFrame,
  SNAPSHOT_SIGNATURE,
  type SnapshotRecord,
  type SnapshotSourceRoots,
} from "../snapshots/format"
import { importSnapshot } from "../snapshots/import"
import { migrateStorage } from "../storage/migrations"
import type {
  BranchNamespaceStorage,
  SnapshotLoadStorage,
  SnapshotReadStorage,
} from "../storage/snapshots"
import type { Storage } from "../storage/types"
import { createTestSixb } from "./execution"
import {
  Customer,
  createHost,
  Invoice,
  ontology,
  ownerOptions,
  PROJECT,
  seededHost,
  TIMEOUT_MS,
} from "./snapshot-contract-fixture"
import { runSnapshotShapesCases } from "./snapshot-shapes-contract"

export interface SnapshotLoadContractProvider<TStorage extends Storage> {
  /** A migrated storage holding no project yet. */
  readonly createStorage: () => Promise<
    TStorage & SnapshotReadStorage & SnapshotLoadStorage & BranchNamespaceStorage
  >
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

/**
 * Loading a snapshot on a storage provider: one base commit or nothing, carrying what production
 * holds, into branch namespaces that keep apart what each one holds.
 */
export function runSnapshotLoadContractSuite<TStorage extends Storage>(
  name: string,
  provider: SnapshotLoadContractProvider<TStorage>
): void {
  async function withStorage(
    run: (
      storage: TStorage & SnapshotReadStorage & SnapshotLoadStorage & BranchNamespaceStorage
    ) => Promise<void>
  ): Promise<void> {
    const storage = await provider.createStorage()
    try {
      await run(storage)
    } finally {
      for (const branch of await storage.listBranchNamespaces()) {
        await storage.dropBranchNamespace(branch)
      }
      await provider.cleanup?.(storage)
    }
  }

  test(
    `${name} carries what production holds into a branch namespace`,
    async () => {
      await withStorage(async (storage) => {
        const production = await seededHost(storage)
        const branchStorage = await storage.createBranchNamespace("feature-a")

        try {
          const report = await importSnapshot({
            snapshot: exportSnapshot(hostSnapshotSource(production), ownerOptions(production)),
            storage: branchStorage,
            ontology: ontology(),
          })
          expect(report.skipped).toEqual([])
          expect(report.users).toBe(2)
          expect(
            report.types.map(({ objectTypeId, objects, links, points, vectors }) => ({
              objectTypeId,
              objects,
              links,
              points,
              vectors,
            }))
          ).toEqual([
            { objectTypeId: Customer.id, objects: 2, links: 2, points: 0, vectors: 2 },
            { objectTypeId: Invoice.id, objects: 3, links: 3, points: 3, vectors: 0 },
          ])

          await migrateStorage(branchStorage, { projectId: PROJECT, ontology: ontology() })
          const branch = createHost(branchStorage)
          const trusted = createTestSixb(branch)

          const customers = await trusted.objects(Customer).query().list()
          expect(customers.objects.map((row) => row.properties)).toEqual([
            {
              id: "c1",
              name: "Ada",
              email: "ada@example.com",
              contract: { type: "artifact", id: "art_k3m9q2x7tp" },
            },
            { id: "c2", name: "Grace", email: "grace@example.com" },
          ])
          const source = await createTestSixb(production).objects(Customer).query().list()
          expect(customers.objects.map((row) => [row.createdAt, row.updatedAt])).toEqual(
            source.objects.map((row) => [row.createdAt, row.updatedAt])
          )

          const invoice = await trusted.objects(Invoice).byId("i2").get()
          expect(invoice?.properties).toEqual({
            id: "i2",
            amount: 20,
            status: "paid",
            memo: "memo-secret-i2",
            temperature: 22,
          })
          const history = await trusted
            .objects(Invoice)
            .byId("i2")
            .telemetry(Invoice.p.temperature)
            .history()
          expect(history.map((point) => point.value)).toEqual([22])

          const [linked] = await trusted.objects.listLinks({
            objectTypeId: Invoice.id,
            objectId: "i1",
            linkId: "customer",
          })
          expect(linked?.targetId).toBe("c1")
          const owned = await trusted.objects.listLinks({
            objectTypeId: Customer.id,
            objectId: "c1",
            linkId: "invoices",
          })
          expect(owned.map((row) => row.targetId).sort()).toEqual(["i1", "i2"])

          // Unique values were derived, so the branch finds by them and refuses a second holder.
          const found = await trusted.objects(Customer).getBy(Customer.p.email, "grace@example.com")
          expect(found?.primaryId).toBe("c2")
          const taken = await trusted
            .objects(Customer)
            .upsert({ properties: { id: "c3", email: "ada@example.com" } })
            .catch((error: unknown) => error)
          expect(taken).toBeInstanceOf(Error)

          // The artifacts an object holds are indexed again from its values.
          const holders = await branchStorage.objects.listArtifactHolders({
            projectId: PROJECT,
            artifactId: "art_k3m9q2x7tp",
            limit: 10,
          })
          expect(holders.holders).toEqual([
            { objectTypeId: Customer.id, primaryId: "c1", propertyId: "contract" },
          ])

          // Vectors arrive with their values: the branch searches them without embedding again.
          const refs = ["c1", "c2"].map((primaryId) => ({ objectTypeId: Customer.id, primaryId }))
          const vectorsOf = (from: SnapshotReadStorage) =>
            from.readSnapshot({ views: 1, maxDurationMs: 60_000 }, async ([view]) =>
              (await view!.readVectors({ projectId: PROJECT, refs }))
                .map(({ ref, profile, configuration, values }) => ({
                  id: ref.primaryId,
                  profile,
                  configuration,
                  values,
                }))
                .sort((left, right) => left.id.localeCompare(right.id))
            )
          const carried = await vectorsOf(branchStorage)
          expect(carried.map((vector) => vector.values)).toEqual([
            [1, 0, 0],
            [0, 1, 0],
          ])
          expect(carried).toEqual(await vectorsOf(storage))

          // The import is one base commit that no one reacts to.
          expect(
            await branchStorage.ontology.outbox.summarize({ projectId: PROJECT })
          ).toMatchObject({ pendingCount: 0 })
          const commit = await branchStorage.ontology.commits.getById({
            projectId: PROJECT,
            id: report.commitId,
          })
          expect(commit?.result.eventCount).toBe(0)

          // An edit on the branch merges into the imported object, as it would in production.
          await trusted.objects(Invoice).upsert({ properties: { id: "i1", amount: 15 } })
          expect((await trusted.objects(Invoice).byId("i1").get())?.properties).toEqual({
            id: "i1",
            amount: 15,
            status: "open",
            memo: "memo-secret-i1",
            temperature: 21,
          })

          const users = await branchStorage.auth?.users.list({ projectId: PROJECT })
          expect(users?.users.map((user) => user.id).sort()).toEqual(["usr_alice", "usr_bob"])
          const groups = await branchStorage.auth?.groupMemberships.listForUser({
            projectId: PROJECT,
            userId: "usr_alice",
          })
          expect(groups?.map((membership) => membership.groupId)).toEqual(["owners"])

          // Production is untouched by the branch's edit.
          const productionInvoice = await createTestSixb(production)
            .objects(Invoice)
            .byId("i1")
            .get()
          expect(productionInvoice?.properties.amount).toBe(10)
          await branch.closeBroker()
        } finally {
          await production.closeBroker()
        }
      })
    },
    TIMEOUT_MS
  )

  test(
    `${name} loads a snapshot all at once or not at all`,
    async () => {
      await withStorage(async (storage) => {
        const production = await seededHost(storage)
        const branchStorage = await storage.createBranchNamespace("feature-b")
        const failure = new Error("the stream broke")

        try {
          const snapshot = exportSnapshot(hostSnapshotSource(production), ownerOptions(production))
          const broken = (async function* () {
            let frames = 0
            for await (const frame of snapshot) {
              if (frames++ === 4) throw failure
              yield frame
            }
          })()

          const refused = await importSnapshot({
            snapshot: broken,
            storage: branchStorage,
            ontology: ontology(),
          }).catch((error: unknown) => error)
          expect(refused).toBe(failure)
          const after = await branchStorage.objects.list({ projectId: PROJECT })
          expect(after.total).toBe(0)

          // Nothing was kept, so the same namespace takes the snapshot again.
          const report = await importSnapshot({
            snapshot: exportSnapshot(hostSnapshotSource(production), ownerOptions(production)),
            storage: branchStorage,
            ontology: ontology(),
          })
          expect(report.types.reduce((total, type) => total + type.objects, 0)).toBe(5)

          // A second load would mix two snapshots: it is refused.
          const again = await importSnapshot({
            snapshot: exportSnapshot(hostSnapshotSource(production), ownerOptions(production)),
            storage: branchStorage,
            ontology: ontology(),
          }).catch((error: unknown) => error)
          expect(String(again)).toContain("holds no object yet")
        } finally {
          await production.closeBroker()
        }
      })
    },
    TIMEOUT_MS
  )

  // Red check: in the provider's snapshot load, skip `sources` or `sourceRoots`: the branch
  // has no active source, or one without its roots.
  test(
    `${name} takes a projection's source over, with the edits over it`,
    async () => {
      await withStorage(async (storage) => {
        const branchStorage = await storage.createBranchNamespace("devices")
        const branch = devicesHost(branchStorage)

        const report = await importSnapshot({
          snapshot: devicesSnapshot(branch),
          storage: branchStorage,
          ontology: branch.definitions.ontology as OntologyRegistry,
          projections: branch.definitions.projections,
        })
        expect(report.types).toEqual([
          expect.objectContaining({ objectTypeId: Device.id, objects: 2, reprojectable: true }),
        ])

        const active = await branchStorage.ontology.sources.getActive({
          projectId: PROJECT,
          source: { projectionId: fromDevices.id },
        })
        expect(active).toMatchObject({
          status: "active",
          rootCount: 2,
          assertionCount: 3,
          datasetVersion: { datasetId: devices.id, versionId: "v1" },
          projectionRevision: "revision",
          lastCommitId: report.commitId,
        })

        await branchStorage.readSnapshot({ views: 1, maxDurationMs: 60_000 }, async ([view]) => {
          const roots = await view!.readSourceRoots({
            projectId: PROJECT,
            projectionId: fromDevices.id,
            limit: 10,
          })
          expect(roots.map(({ root, assertions }) => [root, assertions] as const)).toEqual([
            ...DEVICE_ROOTS,
          ])
          const later = await view!.readSourceRoots({
            projectId: PROJECT,
            projectionId: fromDevices.id,
            afterRootKey: roots[0]!.rootKey,
            limit: 10,
          })
          expect(later.map(({ root }) => root)).toEqual([DEVICE_ROOTS[1]![0]])

          expect(
            await view!.readObjectEdits({ projectId: PROJECT, objectTypeId: Device.id, limit: 10 })
          ).toEqual([DEVICE_EDIT])

          // The link d-2 asserts is its source's: no edit holds it. The edits read in pages of
          // one cross from edges to slots, each in order, as one page of ten reads them.
          const describe = (edit: Awaited<ReturnType<typeof view.readLinkEdits>>[number]) =>
            edit.kind === "edge"
              ? `edge ${edit.ref.source.primaryId}→${edit.ref.target.primaryId} ${edit.value.kind}`
              : `slot ${edit.source.primaryId} ${edit.value.kind}`
          const whole = await view!.readLinkEdits({
            projectId: PROJECT,
            sourceTypeId: Device.id,
            limit: 10,
          })
          const paged: string[] = []
          for (let after: string | undefined; ; ) {
            const page = await view!.readLinkEdits({
              projectId: PROJECT,
              sourceTypeId: Device.id,
              limit: 1,
              ...(after === undefined ? {} : { afterKey: after }),
            })
            if (page.length === 0) break
            paged.push(...page.map(describe))
            after = page.at(-1)?.key
          }
          expect(whole.map(describe)).toEqual([
            "edge d-1→d-2 upsert",
            "edge d-2→d-1 delete",
            "slot d-1 clear",
            "slot d-2 set",
          ])
          expect(paged).toEqual(whole.map(describe))
        })
      })
    },
    TIMEOUT_MS
  )

  // Red check: in import.ts, drop `projections` from the `applyTypeShapes` call: the fill edits
  // d-1, which its source stands for, and the edit masks the value the projection gives it.
  test(
    `${name} fills no property the branch's projection feeds, on an object an action created`,
    async () => {
      await withStorage(async (storage) => {
        const branchStorage = await storage.createBranchNamespace("devices-serial")
        const branch = serialHost(branchStorage)
        const fill = defineMigration("device-serial", SerialDevice).fillProperty(
          "serial",
          () => "unknown"
        )

        const report = await importSnapshot({
          snapshot: createdDevicesSnapshot(),
          storage: branchStorage,
          ontology: branch.definitions.ontology as OntologyRegistry,
          projections: branch.definitions.projections,
          migrations: [fill],
        })
        expect(report.types).toEqual([
          expect.objectContaining({
            objectTypeId: Device.id,
            reprojectable: true,
            migrationIds: ["device-serial"],
          }),
        ])

        // d-1 waits for its projection's serial; d-2, which no source row stands for, is filled.
        await branchStorage.readSnapshot({ views: 1, maxDurationMs: 60_000 }, async ([view]) => {
          const edits = await view!.readObjectEdits({
            projectId: PROJECT,
            objectTypeId: Device.id,
            limit: 10,
          })
          expect(edits.map(({ ref, value }) => [ref.primaryId, value])).toEqual([
            ["d-1", { kind: "create", properties: { name: "A" } }],
            ["d-2", { kind: "create", properties: { name: "B", serial: "unknown" } }],
          ])
        })
      })
    },
    TIMEOUT_MS
  )

  // Red check: in import.ts, pass no `unseenValues` to the gate: the devices are refused, each
  // one's name counted as an edit the code refuses, and the convert rewrites them all.
  test(
    `${name} leaves the values of a type copied as created objects to its projection`,
    async () => {
      await withStorage(async (storage) => {
        const Retyped = retypedDevice()
        const ontology = new OntologyRegistry({ sources: [Retyped] })
        const convert = defineMigration("device-name-length", Retyped).convertProperty(
          "name",
          ({ value }) => String(value).length
        )
        const unchecked = [
          "SnapshotDevice: 'name' changed from string to integer: not checked, the copy can't tell its projection's values from edits.",
        ]

        // The snapshot names the properties, or else every property but the primary may be fed.
        for (const [label, propertyIds, migrations] of [
          ["named", ["name"], []],
          ["unnamed", undefined, []],
          ["converted", ["name"], [convert]],
        ] as const) {
          const branchStorage = await storage.createBranchNamespace(`devices-${label}`)
          const report = await importSnapshot({
            snapshot: copiedDevicesSnapshot(propertyIds),
            storage: branchStorage,
            ontology,
            migrations,
          })

          expect(report.skipped).toEqual([])
          expect(report.types).toEqual([
            expect.objectContaining({
              objectTypeId: Device.id,
              objects: 3,
              reprojectable: false,
              migrationIds: [],
              refusedByDeploy: [],
              unchecked,
            }),
          ])
          expect(await storedName(branchStorage, "d-1")).toBe("A")
        }

        // Its keys are still read: a removal nothing migrates is refused once, counted.
        const removing = await storage.createBranchNamespace("devices-removed")
        const removed = await importSnapshot({
          snapshot: copiedDevicesSnapshot(["name"]),
          storage: removing,
          ontology: new OntologyRegistry({ sources: [unnamedDevice()] }),
        })
        expect(removed.types).toEqual([
          expect.objectContaining({
            refusedByDeploy: [
              "✗ SnapshotDevice: 'name' was removed, and 3 objects hold it.",
              "  Rename or remove it in a migration:",
              '    defineMigration("snapshot-device-name", SnapshotDevice).renameProperty("name", "<new id>")',
              '    defineMigration("snapshot-device-name", SnapshotDevice).removeProperty("name")',
            ],
            unchecked: [],
          }),
        ])
      })
    },
    TIMEOUT_MS
  )

  test(
    `${name} keeps branch namespaces apart`,
    async () => {
      await withStorage(async (storage) => {
        const production = await seededHost(storage)

        try {
          const first = await storage.createBranchNamespace("first")
          const second = await storage.createBranchNamespace("second")
          await importSnapshot({
            snapshot: exportSnapshot(hostSnapshotSource(production), ownerOptions(production)),
            storage: first,
            ontology: ontology(),
          })

          expect((await first.objects.list({ projectId: PROJECT })).total).toBe(5)
          expect((await second.objects.list({ projectId: PROJECT })).total).toBe(0)
          expect((await storage.objects.list({ projectId: PROJECT })).total).toBe(5)

          expect(await storage.listBranchNamespaces()).toEqual(["first", "second"])
          const reopened = await storage.openBranchNamespace("first")
          expect((await reopened?.objects.list({ projectId: PROJECT }))?.total).toBe(5)

          const duplicate = await storage.createBranchNamespace("first").catch((error) => error)
          expect(String(duplicate)).toContain("exists already")
          const invalid = await storage.createBranchNamespace("Not/Valid").catch((error) => error)
          expect(String(invalid)).toContain("is invalid")

          await storage.dropBranchNamespace("first")
          await storage.dropBranchNamespace("first")
          expect(await storage.listBranchNamespaces()).toEqual(["second"])
          expect(await storage.openBranchNamespace("first")).toBeNull()
          expect((await storage.objects.list({ projectId: PROJECT })).total).toBe(5)
        } finally {
          await production.closeBroker()
        }
      })
    },
    TIMEOUT_MS
  )

  runSnapshotShapesCases(name, withStorage)
}

const Device = defineObjectType({
  id: "SnapshotDevice",
  name: "Device",
  properties: [prop("id", "string", { primary: true, required: true }), prop("name", "string")],
  links: [
    link.self("parent", { cardinality: "one" }),
    link.self("related", { cardinality: "many" }),
  ],
})
const devices = defineDataset("snapshot_devices", {
  schema: [col("id", "string"), col("name", "string"), col("parent", "string", { nullable: true })],
})
const fromDevices = defineProjection("snapshot_devices", Device)
  .fromDataset(devices)
  .properties({ id: "id", name: "name" })
  .withLinks({ parent: { link: Device.l.parent, sourceField: "parent", target: Device } })

const object = (primaryId: string) => ({ objectTypeId: Device.id, primaryId })
const DEVICE_ROOTS: SnapshotSourceRoots["roots"] = [
  [
    { kind: "object", ref: object("d-1") },
    [{ kind: "object", ref: object("d-1"), properties: { name: "A" } }],
  ],
  [
    { kind: "object", ref: object("d-2") },
    [
      { kind: "object", ref: object("d-2"), properties: { name: "B" } },
      { kind: "link", ref: { source: object("d-2"), linkId: "parent", target: object("d-1") } },
    ],
  ],
]
const DEVICE_EDIT = {
  ref: object("d-2"),
  value: { kind: "patch", set: { name: "B edited" }, unset: [] },
  editedAt: { name: "2026-01-01T00:00:00.000Z" },
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const

function devicesHost(storage: Storage): SixbHost {
  return new SixbHost({
    id: PROJECT,
    ontology: [Device],
    datasets: [devices],
    projections: [fromDevices],
    blobStorage: new InMemoryBlobStorage(),
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    queues: new InMemoryQueues(),
    storage,
  })
}

/** Devices whose name, which their projection feeds, a branch makes a number. */
function retypedDevice() {
  return defineObjectType({
    id: Device.id,
    name: "Device",
    properties: [prop("id", "string", { primary: true, required: true }), prop("name", "integer")],
    links: [
      link.self("parent", { cardinality: "one" }),
      link.self("related", { cardinality: "many" }),
    ],
  })
}

function unnamedDevice() {
  return defineObjectType({
    id: Device.id,
    name: "Device",
    properties: [prop("id", "string", { primary: true, required: true })],
    links: [
      link.self("parent", { cardinality: "one" }),
      link.self("related", { cardinality: "many" }),
    ],
  })
}

async function storedName(storage: Storage, primaryId: string) {
  const row = await storage.objects.getByPrimaryId({
    projectId: PROJECT,
    objectTypeId: Device.id,
    primaryId,
  })
  return row?.properties.name
}

/**
 * Devices a projection feeds, copied as created objects: the person's copy can't take the
 * projection's source over. `propertyIds` is what production's projection feeds, absent from an
 * earlier snapshot.
 */
async function* copiedDevicesSnapshot(
  propertyIds: readonly string[] | undefined
): AsyncGenerator<Uint8Array> {
  const at = Date.parse(DEVICE_EDIT.updatedAt)
  const records: SnapshotRecord[] = [
    {
      kind: "manifest",
      format: 3,
      projectId: PROJECT,
      takenAt: DEVICE_EDIT.updatedAt,
      takenBy: { type: "user", id: "usr_alice" },
      members: "self",
      types: [
        {
          objectTypeId: Device.id,
          primaryPropertyId: "id",
          shape: {
            fits: typeShape(Device, new OntologyRegistry({ sources: [Device] })),
            state: "current",
            settledMigrationIds: [],
          },
          hiddenPropertyIds: [],
          throughCondition: false,
          vectors: [],
          projection: {
            projectionId: fromDevices.id,
            datasetId: devices.id,
            ...(propertyIds ? { propertyIds } : {}),
            datasetView: true,
            notReprojectable: "the branch does not read production's datasets in place",
          },
        },
      ],
      unreadableTypeIds: [],
    },
    { kind: "members", users: [], memberships: [] },
    {
      kind: "objects",
      objectTypeId: Device.id,
      ids: ["d-1", "d-2", "d-3"],
      createdAt: [at, at, at],
      updatedAt: [at, at, at],
      columns: [
        { propertyId: "id", values: ["d-1", "d-2", "d-3"] },
        { propertyId: "name", values: ["A", "B", "C"] },
      ],
    },
    {
      kind: "end",
      counts: { objects: 3, links: 0, points: 0, vectors: 0, users: 0, sourceRoots: 0, edits: 0 },
    },
  ]

  yield SNAPSHOT_SIGNATURE
  for (const record of records) yield await encodeSnapshotFrame(record, { compress: false })
}

/** Devices as a branch changes them: a required serial, which its projection feeds. */
const SerialDevice = defineObjectType({
  id: Device.id,
  name: "Device",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("name", "string"),
    prop("serial", "string", { required: true }),
  ],
  links: [
    link.self("parent", { cardinality: "one" }),
    link.self("related", { cardinality: "many" }),
  ],
})
const serialDevices = defineDataset("snapshot_devices", {
  schema: [col("id", "string"), col("name", "string"), col("serial", "string")],
})
const serialFromDevices = defineProjection("snapshot_devices", SerialDevice)
  .fromDataset(serialDevices)
  .properties({ id: "id", name: "name", serial: "serial" })

function serialHost(storage: Storage): SixbHost {
  return new SixbHost({
    id: PROJECT,
    ontology: [SerialDevice],
    datasets: [serialDevices],
    projections: [serialFromDevices],
    blobStorage: new InMemoryBlobStorage(),
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    queues: new InMemoryQueues(),
    storage,
  })
}

/**
 * Devices that travel as their source, both created by an action: d-1, which production's
 * projection then asserted too, and d-2, which no source row stands for.
 */
async function* createdDevicesSnapshot(): AsyncGenerator<Uint8Array> {
  const at = Date.parse(DEVICE_EDIT.updatedAt)
  const created = (name: string) => ({ kind: "create", properties: { name } }) as const
  const records: SnapshotRecord[] = [
    {
      kind: "manifest",
      format: 3,
      projectId: PROJECT,
      takenAt: DEVICE_EDIT.updatedAt,
      takenBy: { type: "user", id: "usr_alice" },
      members: "self",
      types: [
        {
          objectTypeId: Device.id,
          primaryPropertyId: "id",
          shape: {
            fits: typeShape(Device, new OntologyRegistry({ sources: [Device] })),
            state: "current",
            settledMigrationIds: [],
          },
          hiddenPropertyIds: [],
          throughCondition: false,
          vectors: [],
          projection: {
            projectionId: fromDevices.id,
            datasetId: devices.id,
            datasetView: true,
            source: {
              datasetVersion: {
                datasetId: devices.id,
                versionId: "v1",
                createdAt: DEVICE_EDIT.updatedAt,
              },
              projectionRevision: "revision",
              ownershipHash: "ownership",
              ontologyRevision: "ontology",
            },
          },
        },
      ],
      unreadableTypeIds: [],
      lake: { catalogVersion: "point" },
    },
    { kind: "members", users: [], memberships: [] },
    {
      kind: "objects",
      objectTypeId: Device.id,
      ids: ["d-1", "d-2"],
      createdAt: [at, at],
      updatedAt: [at, at],
      columns: [{ propertyId: "name", values: ["A", "B"] }],
    },
    { kind: "sourceRoots", projectionId: fromDevices.id, roots: [DEVICE_ROOTS[0]!] },
    {
      kind: "edits",
      objectTypeId: Device.id,
      objects: [
        ["d-1", created("A"), null, at],
        ["d-2", created("B"), null, at],
      ],
      links: [],
      slots: [],
    },
    {
      kind: "end",
      counts: { objects: 2, links: 0, points: 0, vectors: 0, users: 0, sourceRoots: 1, edits: 2 },
    },
  ]

  yield SNAPSHOT_SIGNATURE
  for (const record of records) yield await encodeSnapshotFrame(record, { compress: false })
}

/** A snapshot whose devices travel as their projection's source, with one edit over d-2. */
async function* devicesSnapshot(host: SixbHost): AsyncGenerator<Uint8Array> {
  const at = Date.parse(DEVICE_EDIT.updatedAt)
  const records: SnapshotRecord[] = [
    {
      kind: "manifest",
      format: 3,
      projectId: PROJECT,
      takenAt: DEVICE_EDIT.updatedAt,
      takenBy: { type: "user", id: "usr_alice" },
      members: "self",
      types: [
        {
          objectTypeId: Device.id,
          primaryPropertyId: "id",
          shape: {
            fits: typeShape(Device, host.definitions.ontology),
            state: "current",
            settledMigrationIds: [],
          },
          hiddenPropertyIds: [],
          throughCondition: false,
          vectors: [],
          projection: {
            projectionId: fromDevices.id,
            datasetId: devices.id,
            datasetView: true,
            source: {
              datasetVersion: {
                datasetId: devices.id,
                versionId: "v1",
                createdAt: DEVICE_EDIT.updatedAt,
              },
              projectionRevision: "revision",
              ownershipHash: "ownership",
              ontologyRevision: "ontology",
            },
          },
        },
      ],
      unreadableTypeIds: [],
      lake: { catalogVersion: "point" },
    },
    { kind: "members", users: [], memberships: [] },
    {
      kind: "objects",
      objectTypeId: Device.id,
      ids: ["d-1", "d-2"],
      createdAt: [at, at],
      updatedAt: [at, at],
      columns: [{ propertyId: "name", values: ["A", "B edited"] }],
    },
    {
      kind: "links",
      sourceTypeId: Device.id,
      rows: [["d-2", "parent", Device.id, "d-1", at, at, null]],
    },
    { kind: "sourceRoots", projectionId: fromDevices.id, roots: DEVICE_ROOTS },
    {
      kind: "edits",
      objectTypeId: Device.id,
      objects: [["d-2", DEVICE_EDIT.value, DEVICE_EDIT.editedAt, at]],
      links: [
        [
          { source: object("d-2"), linkId: "related", target: object("d-1") },
          { kind: "delete" },
          at,
        ],
        [
          { source: object("d-1"), linkId: "related", target: object("d-2") },
          { kind: "upsert" },
          at,
        ],
      ],
      slots: [
        ["d-2", "parent", { kind: "set", target: object("d-1") }, at],
        ["d-1", "parent", { kind: "clear", target: object("d-2") }, at],
      ],
    },
    {
      kind: "end",
      counts: { objects: 2, links: 1, points: 0, vectors: 0, users: 0, sourceRoots: 2, edits: 5 },
    },
  ]

  yield SNAPSHOT_SIGNATURE
  for (const record of records) yield await encodeSnapshotFrame(record, { compress: false })
}
