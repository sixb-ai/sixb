import { expect, test } from "bun:test"
import { copySnapshot } from "../snapshots/copy"
import { branchDefinitions } from "../snapshots/definitions"
import { exportSnapshot, hostSnapshotSource } from "../snapshots/export"
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
  clerkOptions,
  createHost,
  Invoice,
  ontology,
  ownerOptions,
  PROJECT,
  seededHost,
  TIMEOUT_MS,
} from "./snapshot-contract-fixture"

export interface SnapshotLoadContractProvider<TStorage extends Storage> {
  /** A migrated storage holding no project yet. */
  readonly createStorage: () => Promise<
    TStorage & SnapshotReadStorage & SnapshotLoadStorage & BranchNamespaceStorage
  >
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
  /**
   * Every row a branch namespace holds, comparable across two loads of one snapshot: for a
   * provider that copies a snapshot in place, which must hold what a load holds. Its commit's
   * id is left out of every row.
   */
  readonly rows?: (storage: TStorage, namespace: string) => Promise<unknown>
  /**
   * For a provider that hands a branch namespace to a role of its own, which the branch's runtime
   * logs in as: what the role does in it.
   */
  readonly roles?: {
    /** Hands the namespace to its role, created the first time. */
    handOver(storage: TStorage, namespace: string): Promise<void>
    /**
     * As the role: empties its namespace, and plants on every table a trigger that fails any
     * statement writing to it, naming who ran it.
     */
    plant(storage: TStorage, namespace: string): Promise<void>
    /** As the role: writes to its namespace. Fails once the trigger is planted. */
    write(storage: TStorage, namespace: string): Promise<void>
    /** Drops the roles the suite created. */
    cleanup(storage: TStorage): Promise<void>
  }
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

  // Reproduce on PostgreSQL: drop the fingerprint check from copyVectors, or write edited_at
  // without its milliseconds, and the copy no longer holds what the load holds; drop the `whole`
  // check from copySnapshot, and a clerk's snapshot is copied with what they cannot read.
  test(
    `${name} copies a snapshot holding exactly what a load of it holds`,
    async () => {
      await withStorage(async (storage) => {
        const production = await seededHost(storage)
        const source = hostSnapshotSource(production)

        try {
          for (const [person, options] of [
            ["owner", ownerOptions(production)],
            ["clerk", clerkOptions(production)],
          ] as const) {
            const copied = await storage.createBranchNamespace(`copied-${person}`)
            const loaded = await storage.createBranchNamespace(`loaded-${person}`)

            const copy = await copySnapshot({
              source,
              scope: options.scope,
              storage: copied,
              definitions: branchDefinitions(ontology()),
            })
            const load = await importSnapshot({
              snapshot: exportSnapshot(source, options),
              storage: loaded,
              ontology: ontology(),
            })

            // Only an owner's snapshot is copied in place, and only where the storage can.
            if (person === "clerk" || !provider.rows) {
              expect(copy).toBeUndefined()
              continue
            }
            const { commitId: _copied, takenAt: _copiedAt, ...copyReport } = copy!
            const { commitId: _loaded, takenAt: _loadedAt, ...loadReport } = load
            expect(copyReport).toEqual(loadReport)

            if (provider.rows) {
              expect(await provider.rows(storage, `copied-${person}`)).toEqual(
                await provider.rows(storage, `loaded-${person}`)
              )
            }
          }
        } finally {
          await production.closeBroker()
        }
      })
    },
    TIMEOUT_MS
  )

  const roles = provider.roles
  if (!roles) return

  // Reproduce on PostgreSQL: drop the owner check from openBranchNamespace, or the one in
  // copySnapshot with the handover's closing of production's connections, and the planted trigger
  // runs as production.
  test(
    `${name} never acts in a namespace handed to its role, a new copy included`,
    async () => {
      await withStorage(async (storage) => {
        const production = await seededHost(storage)
        const source = hostSnapshotSource(production)
        const copy = (into: Storage) =>
          copySnapshot({
            source,
            scope: ownerOptions(production).scope,
            storage: into,
            definitions: branchDefinitions(ontology()),
          })

        try {
          const held = await storage.createBranchNamespace("handed")
          expect((await copy(held))?.types.length).toBeGreaterThan(0)
          await roles.handOver(storage, "handed")

          // What the role may do once it owns its namespace: a trigger runs as whoever writes.
          await roles.plant(storage, "handed")
          expect(String(await roles.write(storage, "handed").catch((error) => error))).toContain(
            "planted trigger"
          )

          const opened = await storage.openBranchNamespace("handed").catch((error) => error)
          expect(String(opened)).toContain("belongs to its role")
          const copied = await copy(held).catch((error) => error)
          expect(String(copied)).toContain("belongs to its role")
          expect(String(copied)).not.toContain("planted trigger")

          // A new copy: the namespace goes, with what the role planted, and a new one is copied.
          await storage.dropBranchNamespace("handed")
          const fresh = await storage.createBranchNamespace("handed")
          expect((await copy(fresh))?.types.length).toBeGreaterThan(0)
          await roles.handOver(storage, "handed")
          await roles.write(storage, "handed")
        } finally {
          await production.closeBroker()
          for (const branch of await storage.listBranchNamespaces()) {
            await storage.dropBranchNamespace(branch)
          }
          await roles.cleanup(storage)
        }
      })
    },
    TIMEOUT_MS
  )
}
