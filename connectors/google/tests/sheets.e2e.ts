/**
 * End-to-end smoke test against Google Sheets API v4.
 *
 * Share the spreadsheet with the authenticated principal and enable the Sheets
 * API in its Google Cloud project.
 *
 * Application Default Credentials (recommended):
 *
 *   GOOGLE_ADC=1 \
 *   GOOGLE_SCOPE="https://www.googleapis.com/auth/spreadsheets.readonly" \
 *   GOOGLE_SHEETS_SPREADSHEET_ID="..." \
 *   bun connectors/google/tests/sheets.e2e.ts
 *
 * Or use GOOGLE_ACCESS_TOKEN / GOOGLE_SA_KEY like the other Google connector
 * smoke tests. GOOGLE_SHEETS_RANGE defaults to `A1:Z10`.
 */
import { google } from "../src/google"
import type { GoogleAuthOptions } from "../src/index"

const accessToken = process.env.GOOGLE_ACCESS_TOKEN
const key = process.env.GOOGLE_SA_KEY
const useApplicationDefault = process.env.GOOGLE_ADC === "1"
const scope = process.env.GOOGLE_SCOPE ?? "https://www.googleapis.com/auth/spreadsheets.readonly"
const subject = process.env.GOOGLE_SUBJECT
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID
const range = process.env.GOOGLE_SHEETS_RANGE ?? "A1:Z10"

if (!spreadsheetId) {
  console.error(
    "Missing GOOGLE_SHEETS_SPREADSHEET_ID. See the header of this file for a complete command."
  )
  process.exit(1)
}

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

console.log(`\nReading spreadsheet metadata for ${spreadsheetId} …`)
const spreadsheet = await client.sheets.spreadsheets.get(spreadsheetId, {
  fields:
    "spreadsheetId,properties(title,locale,timeZone)," +
    "sheets(properties(sheetId,title,index,sheetType,gridProperties))",
})
console.log(`  ${spreadsheet.properties?.title ?? spreadsheet.spreadsheetId}`)
for (const sheet of spreadsheet.sheets ?? []) {
  console.log(`  - ${sheet.properties?.title ?? sheet.properties?.sheetId}`)
}

console.log(`\nReading ${range} …`)
const values = await client.sheets.spreadsheets.values.get(spreadsheetId, range, {
  majorDimension: "ROWS",
  valueRenderOption: "UNFORMATTED_VALUE",
  dateTimeRenderOption: "FORMATTED_STRING",
})
console.log(`  ${values.values?.length ?? 0} row(s).`)
console.log("\nE2E OK.")
