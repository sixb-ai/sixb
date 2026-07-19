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
 *
 * Write pass (opt-in): set GOOGLE_E2E_WRITE=1 and a write-capable scope
 * (GOOGLE_SCOPE="https://www.googleapis.com/auth/drive.file" is enough — the
 * test only touches files it creates). Runs create → update → resumable
 * upload → copy → trash → delete inside GOOGLE_TEST_FOLDER_ID.
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
if (doc) {
  console.log(`\nExporting "${doc.name}" to text/plain …`)
  const bytes = await client.drive.files.export(doc.id, "text/plain")
  const text = new TextDecoder().decode(bytes)
  console.log(`Exported ${bytes.byteLength} bytes. First 500 chars:\n`)
  console.log(text.slice(0, 500))
} else {
  console.log("\nNo Google Doc in the folder — skipping the export check.")
}

if (process.env.GOOGLE_E2E_WRITE !== "1") {
  console.log("\nSkipping write pass (set GOOGLE_E2E_WRITE=1 with a write scope to enable).")
  console.log("\nE2E OK.")
  process.exit(0)
}

console.log("\nWrite pass …")

// Everything created below is deleted in the finally block, pass or fail.
const createdIds: string[] = []

try {
  // Metadata + small bytes in one multipart request.
  const created = await client.drive.files.create({
    name: `sixb-e2e-${Date.now()}.txt`,
    parents: [folderId],
    description: "sixb connector-google e2e write pass",
    content: { body: new TextEncoder().encode("hello from sixb e2e v1\n"), mimeType: "text/plain" },
  })
  createdIds.push(created.id)
  console.log(`created ${created.name} (${created.id})`)

  // Content replacement, small enough for multipart again.
  await client.drive.files.update(created.id, {
    content: { body: new TextEncoder().encode("hello from sixb e2e v2\n"), mimeType: "text/plain" },
  })
  console.log("updated content (multipart)")

  // 10 MiB forces the chunked resumable path with a real mid-session 308.
  const big = new Uint8Array(10 * 1024 * 1024)
  crypto.getRandomValues(big)
  await client.drive.files.update(created.id, {
    content: { body: big, mimeType: "application/octet-stream" },
  })
  console.log(`updated content (resumable, ${big.byteLength} bytes)`)

  // Round-trip: the stored size must match what we uploaded.
  const roundTrip = await client.drive.files.get(created.id, { fields: "size" })
  if (roundTrip.size !== String(big.byteLength)) {
    throw new Error(
      `Resumable upload round-trip mismatch: Drive reports ${roundTrip.size} bytes, sent ${big.byteLength}.`
    )
  }
  console.log(`round-trip verified (Drive reports ${roundTrip.size} bytes)`)

  // Unsized stream → one streaming PUT on a resumable session.
  const streamed = await client.drive.files.create({
    name: `sixb-e2e-stream-${Date.now()}.bin`,
    parents: [folderId],
    content: {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 4; i++) {
            controller.enqueue(new Uint8Array(1024 * 1024).fill(i))
          }
          controller.close()
        },
      }),
      mimeType: "application/octet-stream",
    },
  })
  createdIds.push(streamed.id)
  console.log(`streamed ${streamed.name} (${streamed.id})`)

  const copy = await client.drive.files.copy(created.id, { name: `${created.name} copy` })
  createdIds.push(copy.id)
  console.log(`copied to ${copy.id}`)

  await client.drive.files.update(copy.id, { trashed: true })
  console.log("trashed copy")
} finally {
  for (const id of createdIds) {
    await client.drive.files.delete(id).catch(() => {
      console.warn(`cleanup: failed to delete ${id} — delete it manually.`)
    })
  }
  console.log(`deleted ${createdIds.length} test file(s)`)
}

console.log("\nE2E OK.")
