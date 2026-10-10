import { businessStore, initializeDemoSources } from "../lib/sources/source-state"
import { apiRequest, isRecord } from "./api"

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

const run = await apiRequest(`/actions/record-quote-decision`, {
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
if (!isRecord(run) || typeof run.status !== "string") {
  throw new Error("[Northline] Quote decision returned an unexpected response.")
}
if (run.status !== "succeeded") {
  const reason =
    isRecord(run.error) && typeof run.error.message === "string" ? run.error.message : ""
  throw new Error(`[Northline] Quote approval ${run.status}. ${reason}`.trim())
}
console.log(`[Northline] Approved ${quote.quote_number}.`)
