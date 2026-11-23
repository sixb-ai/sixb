import { Database } from "bun:sqlite"
import { runAgentTurnVectorStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

// Searching loads sqlite-vec, which macOS's own SQLite refuses: point SIXB_TEST_SQLITE_LIBRARY at
// an extension-capable one (brew install sqlite) and run this file alone, before any database
// opens. Elsewhere Bun's SQLite loads it.
const library = process.platform === "darwin" ? process.env.SIXB_TEST_SQLITE_LIBRARY : undefined
if (library) Database.setCustomSQLite(library)

runAgentTurnVectorStorageContractSuite("SqliteAgentTurnVectorStore", {
  createStorage: () => new SqliteStorage(),
  teardown: (storage) => storage.close(),
  searches: process.platform !== "darwin" || library !== undefined,
})
