import { resolve } from "node:path"
import type { DuckLakeStorageOptions } from "../types"

/**
 * Stable key for coordinating local catalog users inside this process.
 *
 * PostgreSQL coordinates through the database. In-memory local catalogs have no
 * shared file identity. File-backed local catalogs need equivalent path
 * spellings, such as `lake.ducklake` and `dir/../lake.ducklake`, to map to the
 * same coordination key.
 */
export function localCatalogCoordinationKey(
  options: Pick<DuckLakeStorageOptions, "catalog">
): string | undefined {
  switch (options.catalog.type) {
    case "duckdb":
    case "sqlite":
      if (options.catalog.path === ":memory:") {
        return undefined
      }

      return `${options.catalog.type}:${resolve(options.catalog.path)}`
    case "custom":
      return `custom:${options.catalog.uri}`
    case "postgres":
      return undefined
  }
}
