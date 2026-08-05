/**
 * End-to-end smoke test against the real Gmail API.
 *
 * Not part of `bun test` (it needs a real mailbox). Three authentication modes:
 *
 *   GOOGLE_ADC=1 \
 *   GOOGLE_SCOPE=https://www.googleapis.com/auth/gmail.readonly \
 *   bun connectors/google/tests/gmail.e2e.ts
 *
 *   GOOGLE_ACCESS_TOKEN="$(...)" bun connectors/google/tests/gmail.e2e.ts
 *
 *   GOOGLE_SA_KEY="$(cat service-account.json)" \
 *   GOOGLE_SUBJECT=user@example.com \
 *   GOOGLE_SCOPE=https://www.googleapis.com/auth/gmail.readonly \
 *   bun connectors/google/tests/gmail.e2e.ts
 *
 * Service accounts need domain-wide delegation and GOOGLE_SUBJECT to access a user's mailbox.
 * Set GOOGLE_GMAIL_WRITE=1 with `gmail.compose` or `gmail.modify` to run a self-cleaning draft
 * create → get → delete round-trip. The test never sends mail.
 */
import { google } from "../src/google"
import type { GoogleAuthOptions } from "../src/index"

const accessToken = process.env.GOOGLE_ACCESS_TOKEN
const key = process.env.GOOGLE_SA_KEY
const useApplicationDefault = process.env.GOOGLE_ADC === "1"
const scope = process.env.GOOGLE_SCOPE ?? "https://www.googleapis.com/auth/gmail.readonly"
const subject = process.env.GOOGLE_SUBJECT
const runWrite = process.env.GOOGLE_GMAIL_WRITE === "1"

if (!useApplicationDefault && !accessToken && !key) {
  console.error(
    "Missing env. Set one of:\n" +
      "  - GOOGLE_ADC=1         (Application Default Credentials, recommended)\n" +
      "  - GOOGLE_ACCESS_TOKEN  (pre-minted short-lived user token)\n" +
      "  - GOOGLE_SA_KEY plus GOOGLE_SUBJECT (domain-wide delegation)\n" +
      "See the header of this file for full commands."
  )
  process.exit(1)
}

if (key && !subject) {
  console.error("Gmail service-account authentication requires GOOGLE_SUBJECT.")
  process.exit(1)
}

const auth: GoogleAuthOptions = useApplicationDefault
  ? { applicationDefault: true, scopes: [scope] }
  : accessToken
    ? { token: () => accessToken }
    : { serviceAccountKey: key as string, scopes: [scope], subject: subject as string }

const client = await google({ auth }).connect({
  projectId: "e2e",
  connectorId: "google",
  signal: new AbortController().signal,
})

console.log("\nGET /users/me/profile …")
const profile = await client.gmail.users.getProfile("me")
console.log(
  `  ${profile.emailAddress}: ${profile.messagesTotal ?? 0} message(s), history ${profile.historyId}`
)

console.log("\nGET /users/me/labels …")
const labels = await client.gmail.labels.list("me")
console.log(`  ${labels.labels?.length ?? 0} label(s).`)

console.log("\nGET /users/me/messages …")
const messages = await client.gmail.messages.list("me", { maxResults: 5 })
console.log(`  ${messages.messages?.length ?? 0} recent message reference(s).`)
const first = messages.messages?.[0]
if (first?.id) {
  const message = await client.gmail.messages.get("me", first.id, {
    format: "metadata",
    metadataHeaders: ["From", "Subject", "Date"],
  })
  console.log(`  fetched ${message.id} (${message.sizeEstimate ?? 0} bytes).`)
}

if (!runWrite) {
  console.log("\nSkipping draft pass (set GOOGLE_GMAIL_WRITE=1 with a compose scope to enable).")
  console.log("\nE2E OK.")
  process.exit(0)
}

const raw = [
  `To: ${profile.emailAddress}`,
  "Subject: [sixb e2e] unsent draft",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "This draft is created and immediately deleted by the Sixb Gmail connector e2e test.",
].join("\r\n")
const encoded = btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
let draftId: string | undefined

try {
  console.log("\nDraft round-trip (create → get → delete) …")
  const draft = await client.gmail.drafts.create("me", { message: { raw: encoded } })
  draftId = draft.id
  if (!draftId) {
    throw new Error("Gmail returned a draft without an id.")
  }
  const fetched = await client.gmail.drafts.get("me", draftId, { format: "metadata" })
  console.log(`  created and fetched ${fetched.id}.`)
} finally {
  if (draftId) {
    await client.gmail.drafts.delete("me", draftId)
    console.log(`  deleted ${draftId}.`)
  }
}

console.log("\nE2E OK.")
