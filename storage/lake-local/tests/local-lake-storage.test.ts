import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runLakeStorageContractSuite } from "@sixb/core/testing"
import { LocalLakeStorage } from "../src"

const roots = new WeakMap<LocalLakeStorage, string>()

runLakeStorageContractSuite("LocalLakeStorage", {
  async createStorage() {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-lake-local-contract-"))
    const storage = new LocalLakeStorage({ path: join(rootDir, "lake") })
    roots.set(storage, rootDir)
    return storage
  },
  async teardown(storage) {
    const rootDir = roots.get(storage)
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true })
    }
  },
})
