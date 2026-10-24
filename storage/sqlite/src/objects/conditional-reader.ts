import type { Database } from "bun:sqlite"
import type {
  CompiledConditionalObjectReadScope,
  ObjectQueryCapabilities,
  ObjectReadStorage,
} from "@sixb/core/storage"
import { compileSqliteConditionalObjectReadSource } from "./read-scope"
import { createSqliteScopedReader } from "./scoped-reader"

/** Read objects and links through relations that apply the scope's conditions as they are read. */
export function createSqliteConditionalReader(
  db: Database,
  params: {
    projectId: string
    scope: CompiledConditionalObjectReadScope
  },
  queryCapabilities: () => ObjectQueryCapabilities
): ObjectReadStorage {
  return createSqliteScopedReader(
    db,
    {
      projectId: params.projectId,
      source: compileSqliteConditionalObjectReadSource(params.projectId, params.scope),
    },
    queryCapabilities
  )
}
