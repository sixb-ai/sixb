import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { google } from "../src/google"
import type { GoogleClient } from "../src/index"
import { CONTEXT, collect, json, mockFetch, restoreFetch } from "./helpers"

const BASE = "https://meet.googleapis.com/v2/"

interface RecordedRequest {
  readonly url: URL
  readonly method: string
  readonly auth: string | null
  readonly body: unknown
}

let requests: RecordedRequest[]

async function connect(options?: { readonly retry?: boolean }): Promise<GoogleClient> {
  return google({
    auth: { token: () => "meet-token" },
    retry: options?.retry ? { maxRetries: 1, delayMs: () => 0 } : { maxRetries: 0 },
  }).connect(CONTEXT)
}

function record(input: RequestInfo | URL, init?: RequestInit): void {
  let body: unknown
  if (typeof init?.body === "string") {
    body = JSON.parse(init.body)
  }
  requests.push({
    url: new URL(input.toString()),
    method: init?.method ?? "GET",
    auth: new Headers(init?.headers).get("authorization"),
    body,
  })
}

beforeEach(() => {
  requests = []
  mockFetch(async (input, init) => {
    record(input, init)
    return json({})
  })
})

afterEach(restoreFetch)

describe("meet.spaces", () => {
  test("routes create, get, patch, and endActiveConference", async () => {
    const spaces = (await connect()).meet.spaces

    await spaces.create(
      {
        config: {
          accessType: "TRUSTED",
          artifactConfig: {
            recordingConfig: { autoRecordingGeneration: "ON" },
            transcriptionConfig: { autoTranscriptionGeneration: "ON" },
          },
        },
      },
      { fields: "name,meetingUri,meetingCode,config" }
    )
    await spaces.get("spaces/abc-mnop-xyz", { fields: "name,activeConference" })
    await spaces.patch(
      { name: "spaces/stable-id", config: { moderation: "ON" } },
      { updateMask: "config.moderation", fields: "name,config" }
    )
    await spaces.endActiveConference("spaces/stable-id")

    expect(requests.map((request) => request.url.toString())).toEqual([
      `${BASE}spaces?fields=name%2CmeetingUri%2CmeetingCode%2Cconfig`,
      `${BASE}spaces/abc-mnop-xyz?fields=name%2CactiveConference`,
      `${BASE}spaces/stable-id?updateMask=config.moderation&fields=name%2Cconfig`,
      `${BASE}spaces/stable-id:endActiveConference`,
    ])
    expect(requests.map((request) => request.method)).toEqual(["POST", "GET", "PATCH", "POST"])
    expect(requests[0]?.auth).toBe("Bearer meet-token")
    expect(requests[0]?.body).toEqual({
      config: {
        accessType: "TRUSTED",
        artifactConfig: {
          recordingConfig: { autoRecordingGeneration: "ON" },
          transcriptionConfig: { autoTranscriptionGeneration: "ON" },
        },
      },
    })
    expect(requests[2]?.body).toEqual({
      name: "spaces/stable-id",
      config: { moderation: "ON" },
    })
    expect(requests[3]?.body).toEqual({})
  })
})

describe("meet.conferenceRecords", () => {
  test("gets, lists, filters, and paginates conference records", async () => {
    let listPage = 0
    mockFetch(async (input, init) => {
      record(input, init)
      const url = new URL(input.toString())
      if (url.pathname.endsWith("/conferenceRecords/record-1")) {
        return json({ name: "conferenceRecords/record-1", space: "spaces/stable-id" })
      }
      const pages = [
        {
          conferenceRecords: [{ name: "conferenceRecords/record-1" }],
          nextPageToken: "page-2",
        },
        { conferenceRecords: [{ name: "conferenceRecords/record-2" }] },
      ]
      return json(pages[listPage++])
    })

    const records = (await connect()).meet.conferenceRecords
    const conference = await records.get("conferenceRecords/record-1", { fields: "name,space" })
    const all = await collect(
      records.listAll({
        pageSize: 25,
        filter: 'space.meeting_code = "abc-mnop-xyz"',
      })
    )

    expect(conference.space).toBe("spaces/stable-id")
    expect(all.map((item) => item.name)).toEqual([
      "conferenceRecords/record-1",
      "conferenceRecords/record-2",
    ])
    expect(requests[1]?.url.searchParams.get("filter")).toBe('space.meeting_code = "abc-mnop-xyz"')
    expect(requests[1]?.url.searchParams.get("pageSize")).toBe("25")
    expect(requests[2]?.url.searchParams.get("pageToken")).toBe("page-2")
  })
})

describe("meet conference children", () => {
  // Guard proof: remove `smartNotes: meetSmartNotesResource(http)` from
  // `conferenceRecords.ts`; the artifact-routing test below fails before any request is sent.
  test("routes participants and participant sessions", async () => {
    const records = (await connect()).meet.conferenceRecords
    const participant = "conferenceRecords/record-1/participants/person-1"
    const session = `${participant}/participantSessions/session-1`

    await records.participants.get(participant, { fields: "name,signedinUser" })
    await records.participants.list("conferenceRecords/record-1", {
      pageSize: 250,
      filter: "latest_end_time IS NULL",
    })
    await records.participants.participantSessions.get(session)
    await records.participants.participantSessions.list(participant, {
      pageSize: 100,
      filter: "end_time IS NULL",
    })

    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/v2/conferenceRecords/record-1/participants/person-1",
      "/v2/conferenceRecords/record-1/participants",
      "/v2/conferenceRecords/record-1/participants/person-1/participantSessions/session-1",
      "/v2/conferenceRecords/record-1/participants/person-1/participantSessions",
    ])
    expect(requests[1]?.url.searchParams.get("filter")).toBe("latest_end_time IS NULL")
    expect(requests[3]?.url.searchParams.get("filter")).toBe("end_time IS NULL")
  })

  test("routes recordings, transcripts, transcript entries, and smart notes", async () => {
    const records = (await connect()).meet.conferenceRecords
    const parent = "conferenceRecords/record-1"
    const transcript = `${parent}/transcripts/transcript-1`

    await records.recordings.get(`${parent}/recordings/recording-1`)
    await records.recordings.list(parent, { pageSize: 10 })
    await records.transcripts.get(transcript)
    await records.transcripts.list(parent, { pageSize: 10 })
    await records.transcripts.entries.get(`${transcript}/entries/entry-1`)
    await records.transcripts.entries.list(transcript, { pageSize: 100 })
    await records.smartNotes.get(`${parent}/smartNotes/note-1`)
    await records.smartNotes.list(parent, { pageSize: 10 })

    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/v2/conferenceRecords/record-1/recordings/recording-1",
      "/v2/conferenceRecords/record-1/recordings",
      "/v2/conferenceRecords/record-1/transcripts/transcript-1",
      "/v2/conferenceRecords/record-1/transcripts",
      "/v2/conferenceRecords/record-1/transcripts/transcript-1/entries/entry-1",
      "/v2/conferenceRecords/record-1/transcripts/transcript-1/entries",
      "/v2/conferenceRecords/record-1/smartNotes/note-1",
      "/v2/conferenceRecords/record-1/smartNotes",
    ])
  })

  test("listAll selects nested artifacts and preserves the initial page token", async () => {
    let page = 0
    mockFetch(async (input, init) => {
      record(input, init)
      return json(
        page++ === 0
          ? { transcripts: [{ name: "transcripts/1" }], nextPageToken: "next" }
          : { transcripts: [{ name: "transcripts/2" }] }
      )
    })

    const transcripts = await collect(
      (await connect()).meet.conferenceRecords.transcripts.listAll("conferenceRecords/record-1", {
        pageToken: "initial",
      })
    )

    expect(transcripts.map((item) => item.name)).toEqual(["transcripts/1", "transcripts/2"])
    expect(requests[0]?.url.searchParams.get("pageToken")).toBe("initial")
    expect(requests[1]?.url.searchParams.get("pageToken")).toBe("next")
  })
})

describe("meet validation and retry safety", () => {
  test("rejects malformed resource names and unsupported page sizes locally", async () => {
    const meet = (await connect()).meet

    expect(() => meet.spaces.get("abc-mnop-xyz")).toThrow(/spaces\/\{spaceOrMeetingCode\}/)
    expect(() => meet.conferenceRecords.get("record-1")).toThrow(
      /conferenceRecords\/\{conferenceRecord\}/
    )
    expect(() =>
      meet.conferenceRecords.participants.list("conferenceRecords/record-1", { pageSize: 251 })
    ).toThrow(/between 1 and 250/)
    expect(() =>
      meet.conferenceRecords.transcripts.entries.get(
        "conferenceRecords/record-1/transcripts/transcript-1"
      )
    ).toThrow(/entries\/\{entry\}/)
    expect(() => meet.conferenceRecords.list({ pageSize: 0 })).toThrow(/between 1 and 100/)
    expect(requests).toHaveLength(0)
  })

  test("retries reads but never replays Meet mutations", async () => {
    let attempts = 0
    mockFetch(async (input, init) => {
      record(input, init)
      attempts++
      return attempts === 1 ? new Response("busy", { status: 503 }) : json({ name: "spaces/x" })
    })
    const spaces = (await connect({ retry: true })).meet.spaces

    await spaces.get("spaces/stable-id")
    expect(attempts).toBe(2)

    attempts = 0
    mockFetch(async (input, init) => {
      record(input, init)
      attempts++
      return new Response("busy", { status: 503 })
    })
    await expect(spaces.create()).rejects.toThrow(/Google API request failed/)
    expect(attempts).toBe(1)
  })
})
