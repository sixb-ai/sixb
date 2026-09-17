import type { Database } from "bun:sqlite"
import { ObjectQueryExecutionError } from "@sixb/core"
import { load } from "sqlite-vec"

const loaded = new WeakSet<Database>()

/** Load only for vector reads, leaving ordinary SQLite use independent of extension support. */
export function ensureSqliteVectorSearch(db: Database): void {
  if (loaded.has(db)) return
  const options = db.query<{ compile_options: string }, []>("PRAGMA compile_options").all()
  if (options.some((option) => option.compile_options === "OMIT_LOAD_EXTENSION")) {
    throw new ObjectQueryExecutionError(
      "vector_extension_missing",
      "SQLite vector search requires extension support. On macOS install SQLite (brew install sqlite), then call Database.setCustomSQLite with its library path before opening any database."
    )
  }
  try {
    load(db)
    loaded.add(db)
  } catch (cause) {
    throw new Error(
      "[SixbSqlite] Could not load sqlite-vec for vector search. Check that its native package supports your platform.",
      { cause }
    )
  }
}
