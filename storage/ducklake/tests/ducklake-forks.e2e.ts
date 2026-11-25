import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runLakeForksContractSuite } from "@sixb/core/testing"
import { DuckLakeStorage } from "../src"
import { createLocalDuckLakeStorage } from "./test-utils"

const roots = new WeakMap<DuckLakeStorage, string>()

for (const catalog of ["duckdb", "sqlite"] as const) {
  runLakeForksContractSuite(`DuckLakeStorage ${catalog} forks contract`, {
    async createStorage() {
      const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-forks-"))
      const storage = createLocalDuckLakeStorage(rootDir, catalog)
      roots.set(storage, rootDir)
      return storage
    },
    async teardown(storage) {
      await storage.close()
      const rootDir = roots.get(storage)
      if (rootDir) await rm(rootDir, { recursive: true, force: true })
    },
    openBranch: ({ slicePath, filesUrl, token, directory }) =>
      new DuckLakeStorage({
        catalog: { type: "duckdb", path: slicePath },
        dataPath: join(directory, "data"),
        productionFiles: { url: filesUrl, token, cacheDirectory: join(directory, "cache") },
      }),
  })
}
