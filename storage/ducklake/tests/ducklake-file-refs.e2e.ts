import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, defineDataset, type FileRef } from "@sixb/core"
import type { DuckLakeStorage } from "../src"
import { collectRows, createLocalDuckLakeStorage } from "./test-utils"

const documentsDataset = defineDataset("raw.docs", {
  schema: [col("id", "string"), col("attachment", "fileRef", { nullable: true })],
})

const invoiceRef: FileRef = {
  blobId: `blob_${"a".repeat(64)}`,
  digest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 15,
  fileName: "invoice.txt",
  mediaType: "text/plain",
  logicalPath: "invoices/invoice.txt",
}

describe("DuckLakeStorage fileRef rows", () => {
  let rootDir: string
  let storage: DuckLakeStorage

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-file-refs-"))
    storage = createLocalDuckLakeStorage(rootDir)
    await storage.createDataset(documentsDataset)
  })

  afterEach(async () => {
    await storage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  test("round-trips fileRef values as row metadata only", async () => {
    const write = await storage.beginWrite({
      dataset: documentsDataset,
      mode: "snapshot",
    })

    await write.writeRows([
      { id: "doc_1", attachment: invoiceRef },
      { id: "doc_2", attachment: null },
    ])
    await write.commit()

    expect(await collectRows(storage.readRows({ datasetId: documentsDataset.id }))).toEqual([
      { id: "doc_1", attachment: invoiceRef },
      { id: "doc_2", attachment: null },
    ])
  })
})
