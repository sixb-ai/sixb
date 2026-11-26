import { test as bunTest, describe, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, defineDataset } from "../datasets"
import { change } from "../datasets/changes"
import type { DatasetDefinition } from "../datasets/types"
import type { LakeForks } from "../lake-storage/forks"
import type { DatasetRow, DatasetVersionRef, LakeStorage } from "../lake-storage/types"

/** A lake production can cut slices of. */
export type ForkableLakeStorage = LakeStorage & { readonly forks: LakeForks }

export interface LakeForksContractSuiteOptions<TStorage extends ForkableLakeStorage> {
  /** A new, empty lake for every test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly teardown?: (storage: TStorage) => void | Promise<void>
  /**
   * The lake a branch attaches a slice as: the slice at `slicePath` is its catalog, `filesUrl`
   * serves production's files to `token`, and `directory` is the branch's own.
   */
  readonly openBranch: (input: OpenBranchLakeInput) => LakeStorage | Promise<LakeStorage>
}

export interface OpenBranchLakeInput {
  readonly slicePath: string
  readonly filesUrl: string
  readonly token: () => string
  readonly directory: string
}

const invoices = defineDataset("contract.forks.invoices", {
  schema: [col("id", "string"), col("customer", "string"), col("amount", "float64")],
  primaryKey: "id",
})
const invoicesWithStatus = defineDataset("contract.forks.invoices", {
  schema: [...invoices.schema.columns, col("status", "string", { nullable: true })],
  primaryKey: "id",
})
const events = defineDataset("contract.forks.events", {
  schema: [col("id", "string"), col("revision", "int64"), col("state", "string")],
  primaryKey: "id",
  sequenceBy: "revision",
})
const salaries = defineDataset("contract.forks.salaries", {
  schema: [col("id", "string"), col("amount", "float64")],
  primaryKey: "id",
})
const later = defineDataset("contract.forks.later", { schema: [col("id", "string")] })

const TOKEN = "contract-slice-token"

/**
 * Each test seeds a history, cuts a slice and opens a branch on real files: seconds on a slow
 * runner, past the 5 s default.
 */
const test = (name: string, run: () => Promise<void>) => bunTest(name, run, 30_000)

/**
 * What a lake that branches read in place promises: a slice holds exactly the versions it was
 * cut with, as production reads them (deletes and rows kept in the catalog included), nothing of
 * any other dataset nor of anything committed after its point, and reads only the files
 * the cut recorded before it wrote any, which `openFile` serves byte for byte. A branch writing over the slice
 * changes nothing in production.
 */
export function runLakeForksContractSuite<TStorage extends ForkableLakeStorage>(
  label: string,
  options: LakeForksContractSuiteOptions<TStorage>
): void {
  const withLakes = async (
    run: (input: { readonly production: TStorage; readonly directory: string }) => Promise<void>
  ) => {
    const production = await options.createStorage()
    const directory = await mkdtemp(join(tmpdir(), "sixb-lake-forks-contract-"))
    try {
      await run({ production, directory })
    } finally {
      await options.teardown?.(production)
      await rm(directory, { recursive: true, force: true })
    }
  }

  describe(label, () => {
    test("a branch reads exactly the sliced versions, as of the point", async () => {
      await withLakes(async ({ production, directory }) => {
        await seedHistory(production)
        const point = await production.forks.currentPoint()
        await commitAfterPoint(production)

        const at = await production.forks.versionsAt({
          point,
          datasetIds: [invoices.id, events.id, salaries.id, later.id],
        })
        const versions = [invoices.id, events.id].map((datasetId) => ref(at, datasetId))
        expect(at.get(later.id)).toBeNull()
        expect(ref(at, invoices.id).versionId).not.toBe(
          (await production.getLatestVersion(invoices.id))?.versionId
        )

        const slicePath = join(directory, "slice.ducklake")
        const recorded: ReadonlySet<string>[] = []
        const served = await production.forks.writeSlice({
          point,
          versions,
          path: slicePath,
          record: async (paths) => {
            recorded.push(new Set(paths))
          },
        })
        expect(recorded).toEqual([served])
        const files = await serveFiles(production, served)
        try {
          const branch = await options.openBranch({
            slicePath,
            filesUrl: files.url,
            token: () => TOKEN,
            directory: join(directory, "branch"),
          })
          try {
            expect((await branch.listDatasets()).map((dataset) => dataset.id).sort()).toEqual(
              [events.id, invoices.id].sort()
            )
            expect(await branch.getDataset(salaries.id)).toBeNull()
            expect(await branch.getDataset(later.id)).toBeNull()

            for (const version of versions) {
              expect(await sortedRows(branch.readRows({ datasetId: version.datasetId }))).toEqual(
                await sortedRows(production.readRows(version))
              )
              expect(
                (await branch.listVersions(version.datasetId)).map((listed) => listed.versionId)
              ).toEqual([version.versionId])
            }
            expect(files.refused()).toBe(0)
          } finally {
            await branch.close?.()
          }
        } finally {
          files.stop()
        }
      })
    })

    test("a branch writing over the slice changes nothing in production", async () => {
      await withLakes(async ({ production, directory }) => {
        await seedHistory(production)
        const point = await production.forks.currentPoint()
        const at = await production.forks.versionsAt({ point, datasetIds: [invoices.id] })
        const versions = [ref(at, invoices.id)]
        const slicePath = join(directory, "slice.ducklake")
        const served = await production.forks.writeSlice({
          point,
          versions,
          path: slicePath,
          record: async () => undefined,
        })
        const before = await sortedRows(production.readRows({ datasetId: invoices.id }))
        const files = await serveFiles(production, served)
        try {
          const branch = await options.openBranch({
            slicePath,
            filesUrl: files.url,
            token: () => TOKEN,
            directory: join(directory, "branch"),
          })
          try {
            const merge = await branch.beginMerge({ dataset: invoicesWithStatus })
            await merge.writeChanges([
              change.delete({ id: "inv-0001" }),
              change.upsert({ id: "inv-9999", customer: "Branch", amount: 1, status: "draft" }),
            ])
            await merge.commit()

            expect((await sortedRows(branch.readRows({ datasetId: invoices.id }))).length).toBe(
              before.length
            )
          } finally {
            await branch.close?.()
          }
        } finally {
          files.stop()
        }

        expect((await production.getLatestVersion(invoices.id))?.versionId).toBe(
          versions[0]?.versionId
        )
        expect(await sortedRows(production.readRows({ datasetId: invoices.id }))).toEqual(before)
      })
    })

    test("serves the files a slice reads, byte ranges included, and nothing outside them", async () => {
      await withLakes(async ({ production, directory }) => {
        await seedHistory(production)
        const point = await production.forks.currentPoint()
        const at = await production.forks.versionsAt({
          point,
          datasetIds: [invoices.id, salaries.id],
        })
        const cut = (datasetId: string, name: string) =>
          production.forks.writeSlice({
            point,
            versions: [ref(at, datasetId)],
            path: join(directory, name),
            record: async () => undefined,
          })
        const listed = await cut(invoices.id, "invoices.ducklake")
        const others = await cut(salaries.id, "salaries.ducklake")

        expect(listed.size).toBeGreaterThan(0)
        expect([...others].some((path) => listed.has(path))).toBe(false)

        const [path] = [...listed]
        const file = await production.forks.openFile(path as string)
        if (!file) throw new Error(`No file at '${path}'`)
        const whole = new Uint8Array(await new Response(file.read()).arrayBuffer())
        const part = new Uint8Array(
          await new Response(file.read({ start: 4, endInclusive: 11 })).arrayBuffer()
        )
        expect(whole.length).toBe(file.sizeBytes)
        expect(part).toEqual(whole.subarray(4, 12))

        for (const outside of ["../metadata.ducklake", "/etc/passwd", "a/../../b"]) {
          const opened = await production.forks.openFile(outside).catch((error) => error)
          expect(opened === null || opened instanceof Error).toBe(true)
        }
      })
    })

    test("refuses a slice it could not cut exactly", async () => {
      await withLakes(async ({ production, directory }) => {
        await seedHistory(production)
        const point = await production.forks.currentPoint()
        const at = await production.forks.versionsAt({ point, datasetIds: [invoices.id] })
        await commitAfterPoint(production)
        const afterPoint = await production.getLatestVersion(invoices.id)
        if (!afterPoint) throw new Error("No version after the point")

        const refusals = [
          { point, versions: [{ datasetId: invoices.id, versionId: afterPoint.versionId }] },
          { point, versions: [ref(at, invoices.id), ref(at, invoices.id)] },
        ]
        for (const [index, input] of refusals.entries()) {
          const path = join(directory, `refused-${index}.ducklake`)
          const error = await production.forks
            .writeSlice({ ...input, path, record: async () => undefined })
            .catch((caught) => caught)
          expect(error).toBeInstanceOf(Error)
          expect(await Bun.file(path).exists()).toBe(false)
        }
      })
    })
  })
}

/**
 * Invoices with rows in files, deleted rows and rows kept in the catalog, across a schema change;
 * sequenced events; salaries, which no slice here holds.
 */
async function seedHistory(lake: LakeStorage): Promise<void> {
  await lake.createDataset(invoices)
  await commit(lake, invoices, "snapshot", () =>
    Array.from({ length: 3_000 }, (_, index) => ({
      id: `inv-${String(index).padStart(4, "0")}`,
      customer: `customer-${index % 40}`,
      amount: index / 4,
    }))
  )
  await merge(lake, invoices, [
    ...Array.from({ length: 400 }, (_, index) =>
      change.delete({ id: `inv-${String(index * 7).padStart(4, "0")}` })
    ),
  ])
  await merge(lake, invoices, [
    change.delete({ id: "inv-0002" }),
    change.delete({ id: "inv-0003" }),
    change.upsert({ id: "inv-4000", customer: "Before the new column", amount: 40 }),
  ])

  await lake.createDataset(invoicesWithStatus)
  await merge(lake, invoicesWithStatus, [
    change.upsert({ id: "inv-0005", customer: "Edited", amount: 5, status: "paid" }),
    change.upsert({ id: "inv-5000", customer: "New", amount: 50, status: null }),
  ])

  await lake.createDataset(events)
  for (const revision of [1, 2, 3]) {
    await merge(lake, events, [
      change.upsert({ id: `ev-${revision % 2}`, revision, state: `state-${revision}` }),
    ])
  }

  await lake.createDataset(salaries)
  await merge(lake, salaries, [change.upsert({ id: "emp-1", amount: 1_000 })])
}

async function commitAfterPoint(lake: LakeStorage): Promise<void> {
  await merge(lake, invoicesWithStatus, [
    change.upsert({ id: "inv-0006", customer: "After the point", amount: 6, status: "late" }),
  ])
  await merge(lake, salaries, [change.upsert({ id: "emp-2", amount: 2_000 })])
  await lake.createDataset(later)
  await commit(lake, later, "append", () => [{ id: "later-1" }])
}

async function commit(
  lake: LakeStorage,
  dataset: DatasetDefinition,
  mode: "snapshot" | "append",
  rows: () => DatasetRow[]
): Promise<void> {
  const write = await lake.beginWrite({ dataset, mode })
  await write.writeRows(rows())
  await write.commit()
}

async function merge(
  lake: LakeStorage,
  dataset: DatasetDefinition,
  changes: Parameters<Awaited<ReturnType<LakeStorage["beginMerge"]>>["writeChanges"]>[0]
): Promise<void> {
  const session = await lake.beginMerge({ dataset })
  await session.writeChanges(changes)
  await session.commit({ createInitialVersion: true })
}

function ref(
  versions: ReadonlyMap<string, { readonly versionId: string } | null>,
  datasetId: string
): DatasetVersionRef {
  const version = versions.get(datasetId)
  if (!version) throw new Error(`No version of '${datasetId}' at the point`)
  return { datasetId, versionId: version.versionId }
}

async function sortedRows(rows: AsyncIterable<DatasetRow>): Promise<string[]> {
  const lines: string[] = []
  for await (const row of rows) lines.push(JSON.stringify(row))
  return lines.sort()
}

/** A stand-in for production's file route: the slice's files to its token, nothing else. */
async function serveFiles(lake: ForkableLakeStorage, listed: ReadonlySet<string>) {
  let refused = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
        .slice(1)
        .split("/")
        .map(decodeURIComponent)
        .join("/")
      const file =
        request.headers.get("authorization") === `Bearer ${TOKEN}` && listed.has(path)
          ? await lake.forks.openFile(path)
          : null
      if (!file) {
        refused += 1
        return new Response(null, { status: 404 })
      }

      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "")
      if (request.method === "HEAD" || !range) {
        return new Response(request.method === "HEAD" ? null : file.read(), {
          headers: { "content-length": String(file.sizeBytes), "accept-ranges": "bytes" },
        })
      }

      const start = Number(range[1])
      const endInclusive = Math.min(Number(range[2]), file.sizeBytes - 1)
      return new Response(file.read({ start, endInclusive }), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${endInclusive}/${file.sizeBytes}` },
      })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}/`,
    listed,
    refused: () => refused,
    stop: () => server.stop(true),
  }
}
