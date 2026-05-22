import { join } from "node:path"
import type { DatasetRow } from "@pario/core"
import { DuckLakeStorage, type DuckLakeStorageOptions } from "../src"

export async function collectRows(rows: AsyncIterable<DatasetRow>): Promise<DatasetRow[]> {
  const result: DatasetRow[] = []
  for await (const row of rows) {
    result.push(row)
  }
  return result
}

export function localDuckLakeOptions(rootDir: string): DuckLakeStorageOptions {
  return {
    catalog: {
      type: "duckdb",
      path: join(rootDir, "metadata.ducklake"),
    },
    dataPath: join(rootDir, "data"),
  }
}

export function createLocalDuckLakeStorage(rootDir: string): DuckLakeStorage {
  return new DuckLakeStorage(localDuckLakeOptions(rootDir))
}
