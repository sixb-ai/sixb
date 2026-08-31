/**
 * End-to-end smoke test against a real Google Ads manager account.
 *
 * Not part of `bun test` (it needs a developer token and live account access).
 * Add the service-account email directly to the MCC, then run either:
 *
 *   GOOGLE_ADS_DEVELOPER_TOKEN="..." \
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID="123-456-7890" \
 *   GOOGLE_SA_KEY="$(<service-account.json)" \
 *   bun connectors/google/tests/ads.e2e.ts
 *
 * Or use GOOGLE_ADC=1 / GOOGLE_ACCESS_TOKEN instead of GOOGLE_SA_KEY. Set
 * GOOGLE_ADS_CUSTOMER_ID to force one advertiser; otherwise the first enabled leaf is used.
 */
import type { ConnectorContext } from "@sixb/core"
import {
  GOOGLE_ADS_SCOPE,
  type GoogleAdsManagedCustomer,
  type GoogleAuthOptions,
  googleAds,
} from "../src"

const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN
const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
const operatingCustomerId = process.env.GOOGLE_ADS_CUSTOMER_ID
const accessToken = process.env.GOOGLE_ACCESS_TOKEN
const serviceAccountKey = process.env.GOOGLE_SA_KEY
const useApplicationDefault = process.env.GOOGLE_ADC === "1"

if (
  !developerToken ||
  !loginCustomerId ||
  (!useApplicationDefault && !accessToken && !serviceAccountKey)
) {
  console.error(
    "Missing env. Set GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID, and one of " +
      "GOOGLE_ADC=1, GOOGLE_ACCESS_TOKEN, or GOOGLE_SA_KEY."
  )
  process.exit(1)
}

const auth: GoogleAuthOptions = useApplicationDefault
  ? { applicationDefault: true, scopes: [GOOGLE_ADS_SCOPE] }
  : accessToken
    ? { token: () => accessToken }
    : { serviceAccountKey: serviceAccountKey as string, scopes: [GOOGLE_ADS_SCOPE] }

const context: ConnectorContext = {
  projectId: "e2e",
  connectorId: "google-ads",
  signal: new AbortController().signal,
}
const client = await googleAds({ auth, developerToken, loginCustomerId }).connect(context)

const accessible = await client.customers.listAccessible()
console.log(`Direct grants: ${accessible.join(", ") || "none"}`)

let firstManaged: GoogleAdsManagedCustomer | undefined
for await (const account of client.customers.listManaged()) {
  firstManaged = account
  console.log(
    `First managed advertiser: ${account.id} ${account.descriptiveName ?? ""} ` +
      `[${account.currencyCode ?? "?"}, ${account.timeZone ?? "?"}]`
  )
  break
}

const customerId = operatingCustomerId ?? firstManaged?.id
if (!customerId) {
  throw new Error(
    "No enabled leaf advertiser found. Set GOOGLE_ADS_CUSTOMER_ID to an accessible advertiser."
  )
}

const reports = client.customer(customerId).reports
await reports.search({
  query: "SELECT customer.id FROM customer LIMIT 1",
  validateOnly: true,
})
console.log(`GAQL validation succeeded for ${customerId}.`)

const stream = await reports.searchStream({
  query: "SELECT customer.id FROM customer LIMIT 1",
})
console.log(`SearchStream returned ${stream.length} batch(es).`)

const end = new Date()
const start = new Date(end)
start.setUTCDate(start.getUTCDate() - 6)
let rowCount = 0
for await (const _row of reports.customerDaily({
  startDate: start.toISOString().slice(0, 10),
  endDate: end.toISOString().slice(0, 10),
})) {
  rowCount += 1
}
console.log(`Daily performance returned ${rowCount} row(s).`)
console.log("\nGoogle Ads E2E OK.")
