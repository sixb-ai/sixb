import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { col, defineDataset } from "@sixb/core"
import { DuckLakeStorage } from "../../src"

const rootDir = process.argv[2]
if (!rootDir) throw new Error("Expected a temporary root directory.")
await mkdir(rootDir, { recursive: true })

const source = defineDataset("stream-copy-source", {
  schema: [col("id", "int64"), col("name", "string")],
})
const destination = defineDataset("stream-copy-destination", {
  schema: [col("id", "int64"), col("name", "string")],
})
const storage = new DuckLakeStorage({
  catalog: { type: "duckdb", path: join(rootDir, "metadata.ducklake") },
  dataPath: join(rootDir, "data"),
})

try {
  await storage.createDataset(source)
  await storage.createDataset(destination)

  const sourceWrite = await storage.beginWrite({ dataset: source, mode: "snapshot" })
  await sourceWrite.writeRows(
    Array.from({ length: 5_001 }, (_, index) => ({ id: index, name: `Row ${index}` }))
  )
  await sourceWrite.commit()

  const destinationWrite = await storage.beginWrite({ dataset: destination, mode: "snapshot" })
  await destinationWrite.writeRows(storage.readRows({ datasetId: source.id }))
  const version = await destinationWrite.commit()
  if (version.rowCount !== 5_001) {
    throw new Error(`Expected 5001 copied rows, received ${version.rowCount ?? "unknown"}.`)
  }
} finally {
  await storage.close().catch(() => {})
  await rm(rootDir, { recursive: true, force: true }).catch(() => {})
}
