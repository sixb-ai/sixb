/**
 * End-to-end smoke test against the real Google Drive API.
 *
 * Not part of `bun test` (it needs live credentials). Two ways to authenticate:
 *
 * A) Keyless (recommended) — mint a short-lived token via SA impersonation, no
 *    key, no org-policy change:
 *
 *      GOOGLE_ACCESS_TOKEN="$(gcloud auth print-access-token \
 *        --impersonate-service-account=SA@PROJECT.iam.gserviceaccount.com \
 *        --scopes=https://www.googleapis.com/auth/drive.readonly)" \
 *      GOOGLE_TEST_FOLDER_ID="1AbC...xyz" \
 *      bun connectors/google/tests/drive.e2e.ts
 *
 * B) Service-account key (if key creation is allowed):
 *
 *      GOOGLE_SA_KEY="$(cat service-account.json)" \
 *      GOOGLE_TEST_FOLDER_ID="1AbC...xyz" \
 *      GOOGLE_SCOPE="https://www.googleapis.com/auth/drive.readonly" \
 *      bun connectors/google/tests/drive.e2e.ts
 *
 *    Optional (mode B): GOOGLE_SUBJECT="user@customer.com" to impersonate one user (DWD).
 */
import { google } from "../src/google"
import type { GoogleAuthOptions } from "../src/index"

const accessToken = process.env.GOOGLE_ACCESS_TOKEN
const key = process.env.GOOGLE_SA_KEY
const folderId = process.env.GOOGLE_TEST_FOLDER_ID
const scope = process.env.GOOGLE_SCOPE ?? "https://www.googleapis.com/auth/drive.readonly"
const subject = process.env.GOOGLE_SUBJECT

if (!folderId || (!accessToken && !key)) {
  console.error(
    "Missing env. Set GOOGLE_TEST_FOLDER_ID plus one of:\n" +
      "  - GOOGLE_ACCESS_TOKEN  (keyless, recommended)\n" +
      "  - GOOGLE_SA_KEY        (service-account JSON)\n" +
      "See the header of this file for full commands."
  )
  process.exit(1)
}

const auth: GoogleAuthOptions = accessToken
  ? { token: () => accessToken }
  : subject
    ? { serviceAccountKey: key as string, scopes: [scope], subject }
    : { serviceAccountKey: key as string, scopes: [scope] }

const connector = google({ auth })

const client = await connector.connect({
  projectId: "e2e",
  connectorId: "google",
  signal: new AbortController().signal,
})

console.log(`\nListing files in folder ${folderId} …`)
const list = await client.drive.files.list({
  q: `'${folderId}' in parents and trashed = false`,
  fields: "files(id, name, mimeType, modifiedTime), nextPageToken",
  pageSize: 20,
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
})

const files = list.files ?? []
console.log(`Found ${files.length} file(s):`)
for (const file of files) {
  console.log(`  - ${file.name}  [${file.mimeType}]  ${file.modifiedTime ?? ""}  (${file.id})`)
}

const doc = files.find((f) => f.mimeType === "application/vnd.google-apps.document")
if (!doc) {
  console.log("\nNo Google Doc in the folder to export — list/get path verified. Done.")
  process.exit(0)
}

console.log(`\nExporting "${doc.name}" to text/plain …`)
const bytes = await client.drive.files.export(doc.id, "text/plain")
const text = new TextDecoder().decode(bytes)
console.log(`Exported ${bytes.byteLength} bytes. First 500 chars:\n`)
console.log(text.slice(0, 500))
console.log("\nE2E OK.")
