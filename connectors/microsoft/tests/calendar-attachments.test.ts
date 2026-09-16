import { afterEach, expect, test } from "bun:test"
import { type CalendarAttachmentSession, MicrosoftCalendarUploadError } from "../src"
import { apiError, collect, connect, GRAPH, json, mockFetch, restoreFetch } from "./helpers"

afterEach(restoreFetch)
const chunk = 10 * 320 * 1024
const session: CalendarAttachmentSession = {
  uploadUrl: "https://outlook.office.com/api/v2.0/AttachmentSessions('session')?authtoken=secret",
  expirationDateTime: "2099-01-01T00:00:00Z",
  nextExpectedRanges: ["0"],
}
const attached = {
  id: "a",
  "@odata.type": "#microsoft.graph.fileAttachment" as const,
  name: "file.bin",
}
const completed = () =>
  new Response(null, {
    status: 201,
    headers: {
      location:
        "https://outlook.office.com/api/v2.0/Users('u')/Events('e')/Attachments('a%2B%2F%3D')",
    },
  })

// Countercheck: pass messagePath to the attachment factory; event attachment requests target mail.
test("calendar attachment CRUD and binary downloads always target events", async () => {
  const next = `${GRAPH}users/u/events/e%2F1/attachments?$skiptoken=next`
  const requests = mockFetch((r) => {
    if (r.url.endsWith("/$value")) return new Response(Uint8Array.from([0, 128, 255]))
    if (r.method === "DELETE") return new Response(null, { status: 204 })
    if (r.url.endsWith("/a")) return json(attached)
    return json(r.url === next ? { value: [attached] } : { value: [], "@odata.nextLink": next })
  })
  const { attachments } = (await connect()).calendar
  expect(await collect(attachments.listAll("u", "e/1"))).toEqual([attached])
  expect((await attachments.list("u", "e/1")).value).toEqual([])
  expect(await attachments.get("u", "e/1", "a")).toEqual(attached)
  expect(Array.from(await attachments.download("u", "e/1", "a"))).toEqual([0, 128, 255])
  await attachments.delete("u", "e/1", "a")
  expect(requests.every((r) => r.url.startsWith(`${GRAPH}users/u/events/e%2F1/attachments`))).toBe(
    true
  )
  expect(requests.every((r) => r.headers.get("prefer") === 'IdType="ImmutableId"')).toBe(true)
  mockFetch(() => apiError(405))
  await expect(attachments.downloadResponse("u", "e", "reference")).rejects.toMatchObject({
    status: 405,
  })
})

test("event attachment uploads share Outlook chunks without leaking Graph credentials", async () => {
  let puts = 0
  const requests = mockFetch(async (r) => {
    if (r.method === "POST")
      return json(r.url.endsWith("createUploadSession") ? session : attached, 201)
    expect(r.headers.has("authorization")).toBe(false)
    expect(r.init.credentials).toBe("omit")
    expect(r.init.redirect).toBe("manual")
    expect(r.headers.get("content-range")).toBe(
      puts === 0 ? `bytes 0-${chunk - 1}/${chunk + 3}` : `bytes ${chunk}-${chunk + 2}/${chunk + 3}`
    )
    const bytes = new Uint8Array(await new Response(r.init.body).arrayBuffer())
    expect(bytes[0]).toBe(puts === 0 ? 17 : 29)
    return ++puts === 1
      ? json({
          expirationDateTime: session.expirationDateTime,
          nextExpectedRanges: [String(chunk)],
        })
      : completed()
  })
  const { attachments } = (await connect()).calendar
  await attachments.upload("u", "e", "small.bin", Uint8Array.from([0, 128, 255]))
  expect(JSON.parse(String(requests[0].init.body)).contentBytes).toBe("AID/")
  const bytes = new Uint8Array(chunk + 3)
  bytes[0] = 17
  bytes[chunk] = 29
  expect(await attachments.upload("u", "e", "large.bin", bytes)).toEqual({ id: "a+/=" })
  expect(requests[1].url).toBe(`${GRAPH}users/u/events/e/attachments/createUploadSession`)
  expect(requests).toHaveLength(4)
})

test("calendar upload interruption preserves resumable state and event-specific uncertainty", async () => {
  const requests = mockFetch(() => {
    throw new TypeError("lost final acknowledgement")
  })
  const { attachments } = (await connect({ retry: { maxRetries: 2, shouldRetry: () => true } }))
    .calendar
  const error = await attachments
    .resume({ ...session, nextExpectedRanges: [String(chunk)] }, new Uint8Array(chunk + 3))
    .catch((e: unknown) => e)
  expect(error).toBeInstanceOf(MicrosoftCalendarUploadError)
  expect(error).toMatchObject({
    completionUnknown: true,
    session: { ...session, nextExpectedRanges: [String(chunk)] },
  })
  expect(requests).toHaveLength(1)
  if (!(error instanceof MicrosoftCalendarUploadError))
    throw new Error("Expected calendar upload error")
  mockFetch(() => completed())
  expect(await attachments.resume(error.session, new Uint8Array(chunk + 3))).toEqual({ id: "a+/=" })
  const cancelled = mockFetch(() => new Response(null, { status: 204 }))
  await attachments.cancel(session)
  expect(cancelled[0].method).toBe("DELETE")
  expect(cancelled[0].headers.has("authorization")).toBe(false)
})
