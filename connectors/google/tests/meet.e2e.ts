/**
 * Read-only smoke test against the real Google Meet REST API v2.
 *
 * Meet requires user authentication. Use user ADC, a user OAuth token, or a
 * service account impersonating one Workspace user through domain-wide
 * delegation:
 *
 *   GOOGLE_ADC=1 \
 *   GOOGLE_SCOPE="https://www.googleapis.com/auth/meetings.space.readonly" \
 *   GOOGLE_MEET_SPACE="spaces/abc-mnop-xyz" \
 *   bun connectors/google/tests/meet.e2e.ts
 *
 * Optional:
 *   - GOOGLE_MEET_SPACE: stable space name or meeting-code alias to resolve.
 *   - GOOGLE_MEET_CONFERENCE_RECORD: conference record whose children to list.
 *     When omitted, the newest visible record is used if one exists.
 */
import { google } from "../src/google"
import type { GoogleAuthOptions } from "../src/index"

const accessToken = process.env.GOOGLE_ACCESS_TOKEN
const key = process.env.GOOGLE_SA_KEY
const useApplicationDefault = process.env.GOOGLE_ADC === "1"
const scope = process.env.GOOGLE_SCOPE ?? "https://www.googleapis.com/auth/meetings.space.readonly"
const subject = process.env.GOOGLE_SUBJECT
const requestedSpace = process.env.GOOGLE_MEET_SPACE
const requestedConferenceRecord = process.env.GOOGLE_MEET_CONFERENCE_RECORD

if (!useApplicationDefault && !accessToken && !key) {
  console.error(
    "Missing env. Set one of GOOGLE_ADC=1, GOOGLE_ACCESS_TOKEN, or GOOGLE_SA_KEY with " +
      "GOOGLE_SUBJECT. See the header of this file for a complete command."
  )
  process.exit(1)
}

if (key && !subject) {
  console.error("Meet requires user auth; GOOGLE_SA_KEY mode also requires GOOGLE_SUBJECT (DWD).")
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

let stableSpaceName: string | undefined
if (requestedSpace) {
  console.log(`\nResolving ${requestedSpace} …`)
  const space = await client.meet.spaces.get(requestedSpace)
  stableSpaceName = space.name
  console.log(`  ${space.name} (${space.meetingUri ?? "no meeting URI"})`)
}

console.log("\nListing recent conference records …")
const records = await client.meet.conferenceRecords.list({
  pageSize: 5,
  filter: stableSpaceName ? `space.name = "${stableSpaceName}"` : undefined,
})
for (const record of records.conferenceRecords ?? []) {
  console.log(`  - ${record.name} ${record.startTime ?? ""} → ${record.endTime ?? "active"}`)
}

const conferenceRecord = requestedConferenceRecord ?? records.conferenceRecords?.[0]?.name
if (conferenceRecord) {
  console.log(`\nReading children of ${conferenceRecord} …`)
  const [participants, recordings, transcripts, smartNotes] = await Promise.all([
    client.meet.conferenceRecords.participants.list(conferenceRecord, { pageSize: 10 }),
    client.meet.conferenceRecords.recordings.list(conferenceRecord, { pageSize: 10 }),
    client.meet.conferenceRecords.transcripts.list(conferenceRecord, { pageSize: 10 }),
    client.meet.conferenceRecords.smartNotes.list(conferenceRecord, { pageSize: 10 }),
  ])
  console.log(`  ${participants.participants?.length ?? 0} participant(s)`)
  console.log(`  ${recordings.recordings?.length ?? 0} recording(s)`)
  console.log(`  ${transcripts.transcripts?.length ?? 0} transcript(s)`)
  console.log(`  ${smartNotes.smartNotes?.length ?? 0} smart note(s)`)

  const transcriptName = transcripts.transcripts?.[0]?.name
  if (transcriptName) {
    const entries = await client.meet.conferenceRecords.transcripts.entries.list(transcriptName, {
      pageSize: 10,
    })
    console.log(
      `  ${entries.transcriptEntries?.length ?? 0} transcript entry/entries on first page`
    )
  }
}

console.log("\nE2E OK.")
