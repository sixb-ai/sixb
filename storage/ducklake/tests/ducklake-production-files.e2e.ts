import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { change, col, defineDataset } from "@sixb/core"
import type { DatasetVersionRef } from "@sixb/core/lake-storage"
import { DuckLakeStorage } from "../src"
import { PRODUCTION_FILES_ROOT } from "../src/internal/catalog-slice"
import { ProductionFilesProxy } from "../src/internal/production-files-proxy"
import { collectRows, createLocalDuckLakeStorage } from "./test-utils"

const orders = defineDataset("branch.files.orders", {
  schema: [col("id", "string"), col("amount", "float64")],
  primaryKey: "id",
})

let rootDir: string
let production: DuckLakeStorage

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-production-files-"))
  await mkdir(join(rootDir, "production"))
  production = createLocalDuckLakeStorage(join(rootDir, "production"))
  await production.createDataset(orders)
  const write = await production.beginWrite({ dataset: orders, mode: "snapshot" })
  await write.writeRows(
    Array.from({ length: 5_000 }, (_, index) => ({ id: `o-${index}`, amount: index }))
  )
  await write.commit()
  const merge = await production.beginMerge({ dataset: orders })
  await merge.writeChanges([change.delete({ id: "o-7" })])
  await merge.commit()
})

afterEach(async () => {
  await production.close()
  await rm(rootDir, { recursive: true, force: true })
})

describe("a branch reading production's files", () => {
  // Red check: make ProductionFilesProxy.cacheBlocks fetch every block, cached or not.
  test("reads each file once, then from its disk cache, across restarts", async () => {
    const { files, slicePath } = await slice()
    const route = await serveFiles(files, () => true)
    try {
      for (const reopen of [false, true]) {
        const before = route.bytes()
        const branch = openBranch(slicePath, route.url, () => "token")
        try {
          expect((await collectRows(branch.readRows({ datasetId: orders.id }))).length).toBe(4_999)
        } finally {
          await branch.close()
        }
        if (reopen) expect(route.bytes()).toBe(before)
        else expect(route.bytes()).toBeGreaterThan(0)
      }
    } finally {
      route.stop()
    }
  })

  // Red check: in ProductionFilesProxy.fetchUpstream, give up on the first 401.
  test("asks for a new token once when production refuses the last one", async () => {
    const { files, slicePath } = await slice()
    const tokens = ["expired", "renewed"]
    const route = await serveFiles(files, (token) => token === "renewed")
    try {
      const branch = openBranch(slicePath, route.url, () => tokens.shift() ?? "none")
      try {
        expect((await collectRows(branch.readRows({ datasetId: orders.id }))).length).toBe(4_999)
        expect(route.refused()).toBe(1)
        expect(tokens).toEqual([])
      } finally {
        await branch.close()
      }
    } finally {
      route.stop()
    }
  })

  test("fails a read, naming what to do, when production refuses every token", async () => {
    const { files, slicePath } = await slice()
    const route = await serveFiles(files, () => false)
    const logged = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const branch = openBranch(slicePath, route.url, () => "revoked")
      try {
        const error = await collectRows(branch.readRows({ datasetId: orders.id })).catch(
          (caught) => caught
        )
        expect(error).toBeInstanceOf(Error)
        expect(logged.mock.calls.flat().join("\n")).toContain(
          "Open the branch again from production"
        )
      } finally {
        await branch.close()
      }
    } finally {
      logged.mockRestore()
      route.stop()
    }
  })

  // Red check: let ProductionFilesProxy.serve forward any method, or skip its password check.
  test("the proxy serves DuckDB alone, and only reads", async () => {
    const proxy = new ProductionFilesProxy({
      url: "http://127.0.0.1:9/",
      token: () => "token",
      cacheDirectory: join(rootDir, "cache"),
    })
    try {
      const secret = proxy.secretSql()
      const port = /HTTP_PROXY '127\.0\.0\.1:(\d+)'/.exec(secret)?.[1]
      const password = /HTTP_PROXY_PASSWORD '([^']+)'/.exec(secret)?.[1]
      const target = `${PRODUCTION_FILES_ROOT}main/table/file.parquet`

      const anonymous = await fetch(target, { proxy: `http://127.0.0.1:${port}` })
      const write = await fetch(target, {
        method: "PUT",
        body: "overwrite",
        proxy: `http://sixb:${password}@127.0.0.1:${port}`,
      })
      const elsewhere = await fetch("http://example.invalid/", {
        proxy: `http://sixb:${password}@127.0.0.1:${port}`,
      })

      expect(anonymous.status).toBe(407)
      expect(write.status).toBe(405)
      expect(await write.text()).toContain("never writes production's lake files")
      expect(elsewhere.status).toBe(403)
    } finally {
      await proxy.close()
    }
  })
})

async function slice(): Promise<{
  versions: DatasetVersionRef[]
  slicePath: string
  files: ReadonlySet<string>
}> {
  const point = await production.forks.currentPoint()
  const at = await production.forks.versionsAt({ point, datasetIds: [orders.id] })
  const versionId = at.get(orders.id)?.versionId
  if (!versionId) throw new Error("No version to slice")

  const versions = [{ datasetId: orders.id, versionId }]
  const slicePath = join(rootDir, "slice.ducklake")
  const files = await production.forks.writeSlice({
    point,
    versions,
    path: slicePath,
    record: async () => undefined,
  })
  return { versions, slicePath, files }
}

function openBranch(slicePath: string, url: string, token: () => string): DuckLakeStorage {
  return new DuckLakeStorage({
    catalog: { type: "duckdb", path: slicePath },
    dataPath: join(rootDir, "branch", "data"),
    productionFiles: { url, token, cacheDirectory: join(rootDir, "branch", "cache") },
  })
}

/** Production's file route, reduced to what these tests count. */
async function serveFiles(listed: ReadonlySet<string>, accepts: (token: string) => boolean) {
  let bytes = 0
  let refused = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "")
      if (!accepts(token)) {
        refused += 1
        return new Response(null, { status: 401 })
      }

      const path = new URL(request.url).pathname
        .slice(1)
        .split("/")
        .map(decodeURIComponent)
        .join("/")
      const file = listed.has(path) ? await production.forks.openFile(path) : null
      if (!file) return new Response(null, { status: 404 })
      if (request.method === "HEAD") {
        return new Response(null, { headers: { "content-length": String(file.sizeBytes) } })
      }

      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "") ?? []
      const range = { start: Number(start), endInclusive: Number(end) }
      bytes += range.endInclusive - range.start + 1
      return new Response(file.read(range), { status: 206 })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}/`,
    bytes: () => bytes,
    refused: () => refused,
    stop: () => server.stop(true),
  }
}
