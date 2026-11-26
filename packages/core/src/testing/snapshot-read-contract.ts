import { expect, test } from "bun:test"
import { exportSnapshot, hostSnapshotSource } from "../snapshots/export"
import type { SnapshotReadStorage } from "../storage/snapshots"
import type { Storage } from "../storage/types"
import { createTestSixb } from "./execution"
import {
  Customer,
  clerkOptions,
  ownerOptions,
  PROJECT,
  readSnapshot,
  seededHost,
  TIMEOUT_MS,
} from "./snapshot-contract-fixture"

export interface SnapshotReadContractProvider<TStorage extends Storage> {
  /** A migrated storage holding no project yet. */
  readonly createStorage: () => Promise<TStorage & SnapshotReadStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
  /** What the provider needs before it splits a type into ranges, such as fresh statistics. */
  readonly beforeRanges?: (storage: TStorage) => Promise<void>
}

/**
 * Reading a snapshot on a storage provider: every view keeps one state while production writes,
 * what one person cannot read stays out of the bytes, and a type read in ranges is read once.
 */
export function runSnapshotReadContractSuite<TStorage extends Storage>(
  name: string,
  provider: SnapshotReadContractProvider<TStorage>
): void {
  async function withStorage(run: (storage: TStorage & SnapshotReadStorage) => Promise<void>) {
    const storage = await provider.createStorage()
    try {
      await run(storage)
    } finally {
      await provider.cleanup?.(storage)
    }
  }

  test(
    `${name} keeps one state for every view while production writes`,
    async () => {
      await withStorage(async (storage) => {
        const production = await seededHost(storage)
        const writer = createTestSixb(production).objects(Customer)

        try {
          const seen = await storage.readSnapshot(
            { views: 3, maxDurationMs: 60_000 },
            async (views) => {
              await writer.upsert({
                properties: { id: "c9", name: "Later", email: "later@example.com" },
              })
              await writer.byId("c1").delete()

              return Promise.all(
                views.map(async (view) => {
                  const page = await view.storage.objects.list({
                    projectId: PROJECT,
                    objectTypeId: Customer.id,
                    orderBy: "primaryId",
                    order: "asc",
                  })
                  return page.objects.map((row) => row.primaryId)
                })
              )
            }
          )

          expect(seen.length).toBeGreaterThan(0)
          for (const ids of seen) expect(ids).toEqual(["c1", "c2"])
        } finally {
          await production.closeBroker()
        }
      })
    },
    TIMEOUT_MS
  )

  // Reproduce on any provider: return the unscoped store from objectStorageForAuthority for a
  // principal, and the paid invoice, its link from Ada and its memo leave production.
  test(
    `${name} keeps in production what the person cannot read`,
    async () => {
      await withStorage(async (storage) => {
        const production = await seededHost(storage)

        try {
          const { records, text } = await readSnapshot(
            exportSnapshot(hostSnapshotSource(production), clerkOptions(production))
          )

          const ids = records.flatMap((record) => (record.kind === "objects" ? record.ids : []))
          expect(ids.sort()).toEqual(["c1", "c2", "i1", "i3"])

          const links = records.flatMap((record) =>
            record.kind === "links" ? record.rows.map((row) => `${row[0]}>${row[3]}`) : []
          )
          expect(links.sort()).toEqual(["c1>i1", "i1>c1", "i3>c2"])

          expect(text).not.toContain("i2")
          expect(text).not.toContain("memo-secret")

          const members = records.find((record) => record.kind === "members")
          expect(members?.kind === "members" && members.users.map((user) => user[0])).toEqual([
            "usr_bob",
          ])
          expect(members?.kind === "members" && members.memberships.map((row) => row[1])).toEqual([
            "clerks",
          ])

          const end = records.at(-1)
          expect(end).toEqual({
            kind: "end",
            counts: {
              objects: 4,
              links: 3,
              points: 2,
              vectors: 2,
              users: 1,
              sourceRoots: 0,
              edits: 0,
            },
          })
        } finally {
          await production.closeBroker()
        }
      })
    },
    TIMEOUT_MS
  )

  // Reproduce: return every row of a page in endRange, and a split type repeats objects.
  test(
    `${name} reads a type it splits into ranges once`,
    async () => {
      await withStorage(async (storage) => {
        const production = await seededHost(storage)
        const customers = createTestSixb(production).objects(Customer)
        const ids = Array.from(
          { length: 60 },
          (_, index) => `bulk-${String(index).padStart(3, "0")}`
        )
        for (const id of ids) {
          await customers.upsert({ properties: { id, name: id, email: `${id}@example.com` } })
        }
        await provider.beforeRanges?.(storage)

        try {
          const { records } = await readSnapshot(
            exportSnapshot(hostSnapshotSource(production), {
              ...ownerOptions(production),
              concurrency: 4,
              pageSize: 7,
            })
          )

          const read = records.flatMap((record) =>
            record.kind === "objects" && record.objectTypeId === Customer.id ? record.ids : []
          )
          expect(read.length).toBe(62)
          expect(new Set(read).size).toBe(62)
        } finally {
          await production.closeBroker()
        }
      })
    },
    TIMEOUT_MS
  )
}
