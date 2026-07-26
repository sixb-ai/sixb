/**
 * End-to-end smoke test against the real Google Calendar API.
 *
 * Not part of `bun test` (it needs live credentials). Three ways to authenticate:
 *
 * A) Application Default Credentials (recommended). For local Calendar scopes, first run
 *    `gcloud auth application-default login` with a custom OAuth client and `--scopes`:
 *
 *      GOOGLE_ADC=1 bun connectors/google/tests/calendar.e2e.ts
 *
 * B) Pre-minted short-lived token via SA impersonation. Read-only scope is enough for the
 *    default run:
 *
 *      GOOGLE_ACCESS_TOKEN="$(gcloud auth print-access-token \
 *        --impersonate-service-account=SA@PROJECT.iam.gserviceaccount.com \
 *        --scopes=https://www.googleapis.com/auth/calendar.readonly)" \
 *      bun connectors/google/tests/calendar.e2e.ts
 *
 * C) Service-account key (if key creation is allowed):
 *
 *      GOOGLE_SA_KEY="$(cat service-account.json)" \
 *      GOOGLE_SCOPE="https://www.googleapis.com/auth/calendar.readonly" \
 *      bun connectors/google/tests/calendar.e2e.ts
 *
 *    Optional (mode C): GOOGLE_SUBJECT="user@customer.com" to impersonate one user (DWD).
 *
 * Optional env for either mode:
 *   - GOOGLE_CALENDAR_ID   a calendar to read events / free-busy from (default: "primary")
 *   - GOOGLE_CALENDAR_WRITE=1  additionally run a write round-trip. Needs the broad
 *     .../auth/calendar scope. With no GOOGLE_CALENDAR_ID it creates a throwaway secondary
 *     calendar, runs insert → patch → get → delete on it, then deletes the calendar — fully
 *     self-contained, no sharing required. With GOOGLE_CALENDAR_ID it writes to that calendar.
 *
 *     Note: `gcloud ... print-access-token --scopes=...` honours the requested scope for
 *     impersonated accounts (the "may be ignored" warning is spurious here), so for the write
 *     run pass --scopes=https://www.googleapis.com/auth/calendar.
 */
import { google } from "../src/google"
import type { GoogleAuthOptions } from "../src/index"

const accessToken = process.env.GOOGLE_ACCESS_TOKEN
const key = process.env.GOOGLE_SA_KEY
const useApplicationDefault = process.env.GOOGLE_ADC === "1"
const scope = process.env.GOOGLE_SCOPE ?? "https://www.googleapis.com/auth/calendar.readonly"
const subject = process.env.GOOGLE_SUBJECT
const calendarId = process.env.GOOGLE_CALENDAR_ID ?? "primary"
const runWrite = process.env.GOOGLE_CALENDAR_WRITE === "1"

if (!useApplicationDefault && !accessToken && !key) {
  console.error(
    "Missing env. Set one of:\n" +
      "  - GOOGLE_ADC=1         (Application Default Credentials, recommended)\n" +
      "  - GOOGLE_ACCESS_TOKEN  (pre-minted short-lived token)\n" +
      "  - GOOGLE_SA_KEY        (service-account JSON)\n" +
      "See the header of this file for full commands."
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

console.log("\nGET /colors …")
const colors = await client.calendar.colors.get()
console.log(`  ${Object.keys(colors.event ?? {}).length} event color(s) defined.`)

console.log("\nGET /users/me/calendarList …")
const calendars = await client.calendar.calendarList.list({ maxResults: 20 })
console.log(`  ${calendars.items?.length ?? 0} calendar(s) in the list:`)
for (const c of calendars.items ?? []) {
  console.log(`  - ${c.summary ?? c.id}  [${c.accessRole}]  (${c.id})`)
}

console.log(`\nGET /calendars/${calendarId}/events …`)
const events = await client.calendar.events.list(calendarId, {
  maxResults: 10,
  singleEvents: true,
  orderBy: "startTime",
})
console.log(`  ${events.items?.length ?? 0} upcoming event(s):`)
for (const e of events.items ?? []) {
  const when = e.start?.dateTime ?? e.start?.date ?? "?"
  console.log(`  - ${when}  ${e.summary ?? "(no title)"}  (${e.id})`)
}

console.log("\nPOST /freeBusy …")
const now = new Date()
const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000)
const freebusy = await client.calendar.freebusy.query({
  timeMin: now.toISOString(),
  timeMax: in24h.toISOString(),
  items: [{ id: calendarId }],
})
const busy = freebusy.calendars?.[calendarId]?.busy ?? []
console.log(`  ${busy.length} busy interval(s) in the next 24h.`)

if (runWrite) {
  // Write to an explicit calendar, or spin up a throwaway secondary calendar owned by
  // the authenticated principal so the test needs no pre-shared calendar.
  const explicitId = process.env.GOOGLE_CALENDAR_ID
  let targetId = explicitId
  let scratchCalendar = false
  if (!targetId) {
    const created = await client.calendar.calendars.insert({ summary: "[sixb e2e] scratch" })
    targetId = created.id as string
    scratchCalendar = true
    console.log(`\nCreated scratch calendar ${targetId}`)
  }

  try {
    console.log(`\nWrite round-trip on ${targetId} (insert → patch → get → delete) …`)
    const start = new Date(now.getTime() + 60 * 60 * 1000)
    const end = new Date(now.getTime() + 90 * 60 * 1000)
    const created = await client.calendar.events.insert(targetId, {
      summary: "[sixb e2e] delete me",
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    })
    const eventId = created.id as string
    console.log(`  inserted ${eventId}`)
    const patched = await client.calendar.events.patch(targetId, eventId, { location: "sixb e2e" })
    console.log(`  patched location=${patched.location}`)
    const fetched = await client.calendar.events.get(targetId, eventId)
    console.log(`  got summary=${fetched.summary}`)
    await client.calendar.events.delete(targetId, eventId)
    console.log("  deleted event.")
  } finally {
    if (scratchCalendar) {
      await client.calendar.calendars.delete(targetId)
      console.log("  deleted scratch calendar.")
    }
  }
}

console.log("\nE2E OK.")
