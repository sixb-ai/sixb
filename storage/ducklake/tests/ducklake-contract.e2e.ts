import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runLakeStorageContractSuite } from "@pario/core/testing"
import type { DuckLakeStorage } from "../src"
import { createLocalDuckLakeStorage } from "./test-utils"

const roots = new WeakMap<DuckLakeStorage, string>()

runLakeStorageContractSuite("DuckLakeStorage LakeStorage contract", {
  schemaEvolution: "addNullableColumns",
  missingVersionId: "ducklake:999999",
  async createStorage() {
    const rootDir = await mkdtemp(join(tmpdir(), "pario-ducklake-contract-"))
    const storage = createLocalDuckLakeStorage(rootDir)
    roots.set(storage, rootDir)
    return storage
  },
  async teardown(storage) {
    await storage.close()

    const rootDir = roots.get(storage)
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true })
    }
  },
})
