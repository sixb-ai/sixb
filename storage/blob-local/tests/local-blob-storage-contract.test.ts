import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runBlobStorageContractSuite } from "@sixb/core/testing"
import { LocalBlobStorage } from "../src"

const basePaths = new WeakMap<LocalBlobStorage, string>()

runBlobStorageContractSuite("LocalBlobStorage contract", {
  async createStorage() {
    const basePath = await mkdtemp(join(tmpdir(), "sixb-blob-local-contract-"))
    const storage = new LocalBlobStorage({ basePath })
    basePaths.set(storage, basePath)
    return storage
  },
  async teardown(storage) {
    const basePath = basePaths.get(storage)
    if (basePath) {
      await rm(basePath, { recursive: true, force: true })
    }
  },
})
