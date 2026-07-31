import { apiRequest, isRecord, waitUntil } from "./api"

const syncPlan = [
  ["sync-business-customers", "CustomerAccount", 5],
  ["sync-business-facilities", "Facility", 6],
  ["sync-business-contracts", "ServiceContract", 5],
  // The wait gates the *next* sync, so it belongs on the row that produces what the next
  // one needs. The readings feed telemetry projections onto Equipment, and appending
  // telemetry to an object that does not exist yet fails the whole projection run — so
  // the Equipment objects have to be materialized before the readings sync is requested,
  // not after.
  ["sync-controls-equipment", "Equipment", 10],
  ["sync-controls-readings", null, 0],
  ["sync-controls-alarms", "ServiceCase", 5],
  ["sync-business-quotes", "Quote", 3],
  ["sync-field-technicians", "Technician", 7],
  ["sync-field-work-orders", "WorkOrder", 4],
  ["sync-field-visits", "ServiceVisit", 3],
  ["sync-field-notes", "FieldNote", 4],
] as const

export async function synchronizeDemo(): Promise<void> {
  for (const [syncId, objectTypeId, expectedCount] of syncPlan) {
    const requested = await apiRequest(`/syncs/${encodeURIComponent(syncId)}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commitMessage: "Northline demo synchronization" }),
    })
    const runId = field(requested, "runId")
    await waitUntil(`${syncId} to finish`, async () => {
      const sync = await apiRequest(`/syncs/${encodeURIComponent(syncId)}`)
      if (!isRecord(sync) || !isRecord(sync.latestRun) || sync.latestRun.id !== runId) return false
      if (sync.latestRun.status === "failed") {
        const message = isRecord(sync.latestRun.error)
          ? sync.latestRun.error.message
          : "unknown error"
        throw new Error(`[Northline] ${syncId} failed: ${String(message)}`)
      }
      return sync.latestRun.status === "succeeded"
    })

    if (objectTypeId) {
      await waitUntil(`${objectTypeId} projection`, async () => {
        const result = await apiRequest(
          `/objects?objectTypeId=${encodeURIComponent(objectTypeId)}&limit=1`
        )
        return isRecord(result) && typeof result.total === "number" && result.total >= expectedCount
      })
    }
  }
}

function field(value: unknown, key: string): string {
  if (!isRecord(value) || typeof value[key] !== "string") {
    throw new Error(`[Northline] API response is missing '${key}'.`)
  }
  return value[key]
}

if (import.meta.main) {
  synchronizeDemo()
    .then(() => console.log("[Northline] Demo sources synchronized."))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      console.error("[Northline] Start the example first with `bun run dev`.")
      process.exit(1)
    })
}
