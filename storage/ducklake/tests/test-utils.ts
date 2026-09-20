import { join } from "node:path"
import type { DatasetRow } from "@sixb/core"
import { DuckLakeStorage, type DuckLakeStorageOptions } from "../src"

export async function collectRows(rows: AsyncIterable<DatasetRow>): Promise<DatasetRow[]> {
  const result: DatasetRow[] = []
  for await (const row of rows) {
    result.push(row)
  }
  return result
}

export function localDuckLakeOptions(
  rootDir: string,
  catalog: "duckdb" | "sqlite" = "duckdb"
): DuckLakeStorageOptions {
  return {
    catalog: {
      type: catalog,
      path: join(rootDir, "metadata.ducklake"),
    },
    dataPath: join(rootDir, "data"),
  }
}

export function createLocalDuckLakeStorage(
  rootDir: string,
  catalog: "duckdb" | "sqlite" = "duckdb"
): DuckLakeStorage {
  return new DuckLakeStorage(localDuckLakeOptions(rootDir, catalog))
}
