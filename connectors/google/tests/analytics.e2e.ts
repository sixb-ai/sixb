/**
 * End-to-end smoke test against Google Analytics Admin API v1beta and Data API v1beta.
 *
 * The authenticated principal must have access to at least one GA4 property. For a service
 * account, add its email as a user on the Analytics account or property; Cloud IAM alone does
 * not grant Google Analytics access.
 *
 * Application Default Credentials (recommended):
 *
 *   GOOGLE_ADC=1 \
 *   GOOGLE_SCOPE="https://www.googleapis.com/auth/analytics.readonly" \
 *   bun connectors/google/tests/analytics.e2e.ts
 *
 * Or use GOOGLE_ACCESS_TOKEN / GOOGLE_SA_KEY like the other Google connector smoke tests.
 * Optional: GOOGLE_ANALYTICS_PROPERTY_ID=123456789 selects a property explicitly. Otherwise,
 * the test uses the first property returned by accountSummaries.listAll().
 */
import { google } from "../src/google"
import type { AnalyticsAccountSummary, GoogleAuthOptions } from "../src/index"

const accessToken = process.env.GOOGLE_ACCESS_TOKEN
const key = process.env.GOOGLE_SA_KEY
const useApplicationDefault = process.env.GOOGLE_ADC === "1"
const scope = process.env.GOOGLE_SCOPE ?? "https://www.googleapis.com/auth/analytics.readonly"
const subject = process.env.GOOGLE_SUBJECT

if (!useApplicationDefault && !accessToken && !key) {
  console.error(
    "Missing env. Set one of GOOGLE_ADC=1, GOOGLE_ACCESS_TOKEN, or GOOGLE_SA_KEY. " +
      "See the header of this file for a complete command."
  )
  process.exit(1)
}

const auth: GoogleAuthOptions = useApplicationDefault
  ? { applicationDefault: true, scopes: [scope] }
  : accessToken
    ? { token: () => accessToken }
    : subject
      ? { serviceAccountKey: key as string, scopes: [scope], subject }
      : { serviceAccountKey: key as string, scopes: [scope] }

const client = await google({ auth }).connect({
  projectId: "e2e",
  connectorId: "google",
  signal: new AbortController().signal,
})

console.log("\nDiscovering Analytics accounts and properties …")
const summaries: AnalyticsAccountSummary[] = []
for await (const summary of client.analytics.admin.accountSummaries.listAll({ pageSize: 200 })) {
  summaries.push(summary)
  console.log(`  - ${summary.displayName ?? summary.account} (${summary.account})`)
  for (const property of summary.propertySummaries ?? []) {
    console.log(`      ${property.displayName ?? property.property} (${property.property})`)
  }
}

const explicitPropertyId = process.env.GOOGLE_ANALYTICS_PROPERTY_ID
const propertyName = explicitPropertyId
  ? explicitPropertyId.startsWith("properties/")
    ? explicitPropertyId
    : `properties/${explicitPropertyId}`
  : summaries.flatMap((summary) => summary.propertySummaries ?? [])[0]?.property

if (!propertyName) {
  throw new Error(
    "No Analytics property was discovered. Grant this principal access or set " +
      "GOOGLE_ANALYTICS_PROPERTY_ID."
  )
}

console.log(`\nRunning a seven-day country report for ${propertyName} …`)
const report = await client.analytics.data.properties.runReport(propertyName, {
  dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
  dimensions: [{ name: "country" }],
  metrics: [{ name: "activeUsers" }],
  orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
  limit: "10",
})

for (const row of report.rows ?? []) {
  console.log(
    `  ${row.dimensionValues?.[0]?.value ?? "(unknown)"}: ` +
      `${row.metricValues?.[0]?.value ?? "0"} active user(s)`
  )
}
console.log(`  ${report.rowCount ?? 0} total row(s); ${report.rows?.length ?? 0} shown.`)
console.log("\nE2E OK.")
