import { InMemoryStorage } from "@sixb/core"
import { runRunClaimStorageContractSuite } from "../src/testing"

/** The in-memory stores' rows, reached to leave what only an older version could write. */
type RunRows = Map<string, object>

runRunClaimStorageContractSuite("InMemoryStorage run claims", {
  createStorage: () => new InMemoryStorage(),
  forgetExecution(storage, table, id) {
    const runs = {
      sync_runs: storage.syncRuns,
      pipeline_runs: storage.pipelineRuns,
      workflow_runs: storage.workflowRuns,
    }[table] as unknown as { rows?: RunRows; runs?: RunRows }
    const rows = (runs.rows ?? runs.runs) as RunRows
    const key = `run-claim-contract:${id}`

    rows.set(key, { ...rows.get(key), execution: undefined })
  },
})
