import { runMaterializerStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"
import { getSqliteStorageTestingAdapter } from "../src/testing"

runMaterializerStorageContractSuite("SQLite materializer storage contract", {
  createStorage: () => new SqliteStorage(),
  cleanup: (storage) => storage.close(),
  async countCommitTouches(storage) {
    const row = getSqliteStorageTestingAdapter(storage)
      .db.query("SELECT COUNT(*) AS count FROM ontology_commit_touches")
      .get() as { readonly count: number }
    return row.count
  },
})
