import { runRunClaimStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"
import { getSqliteStorageTestingAdapter } from "../src/testing"

runRunClaimStorageContractSuite("SqliteStorage run claims", {
  createStorage: () => new SqliteStorage(),
  cleanup: (storage) => storage.close(),
  forgetExecution(storage, table, id) {
    getSqliteStorageTestingAdapter(storage)
      .db.query(
        `UPDATE ${table} SET execution_token = NULL, execution_queue_lease_expires_at = NULL WHERE id = ?`
      )
      .run(id)
  },
})
