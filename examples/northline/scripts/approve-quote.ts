import { businessStore, initializeDemoSources } from "../lib/sources/source-state"
import { apiRequest, isRecord, waitUntil } from "./api"

await initializeDemoSources()
const state = await businessStore.read()
const quote = state.quotes.find(
  (item) =>
    (item.status === "sent" || item.status === "internal_review") &&
    item.service_case_id !== undefined
)
if (!quote || !quote.service_case_id) {
  throw new Error("[Northline] No quote is awaiting a decision.")
}

const response = await apiRequest(`/actions/record-quote-decision`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    runId: `demo-approve-${quote.quote_id}`,
    subject: { kind: "object", objectTypeId: "Quote", primaryId: quote.quote_id },
    params: {
      serviceCase: { objectTypeId: "ServiceCase", primaryId: quote.service_case_id },
      decision: "approved",
    },
  }),
})
if (!isRecord(response) || typeof response.runId !== "string") {
  throw new Error("[Northline] Quote decision returned an unexpected response.")
}

await waitUntil("quote approval", async () => {
  const run = await apiRequest(`/action-runs/${encodeURIComponent(response.runId as string)}`)
  if (!isRecord(run)) return false
  if (run.status === "failed") {
    throw new Error(`[Northline] Quote approval failed: ${String(run.error)}`)
  }
  return run.status === "succeeded"
})
console.log(`[Northline] Approved ${quote.quote_number}.`)
