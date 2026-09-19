import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runLakeChangesContractSuite } from "@sixb/core/testing"
import type { DuckLakeStorage } from "../src"
import { createLocalDuckLakeStorage } from "./test-utils"

const roots = new WeakMap<DuckLakeStorage, string>()
runLakeChangesContractSuite("DuckLakeStorage changes", {
  async createStorage() {
    const root = await mkdtemp(join(tmpdir(), "sixb-ducklake-changes-"))
    const storage = createLocalDuckLakeStorage(root)
    roots.set(storage, root)
    return storage
  },
  async teardown(storage) {
    await storage.close()
    await rm(roots.get(storage)!, { recursive: true, force: true })
  },
})
