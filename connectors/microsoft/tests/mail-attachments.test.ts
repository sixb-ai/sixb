import { afterEach, expect, test } from "bun:test"
import {
  type MailAttachmentSession,
  MicrosoftConfigurationError,
  MicrosoftMailUploadError,
  MicrosoftProtocolError,
} from "../src"
import {
  apiError,
  CONTEXT,
  collect,
  connect,
  GRAPH,
  json,
  mockFetch,
  restoreFetch,
} from "./helpers"

afterEach(restoreFetch)
const SIZE = 10 * 320 * 1024
const session: MailAttachmentSession = {
  uploadUrl: "https://outlook.office.com/api/v2.0/AttachmentSessions('session')?authtoken=secret",
  expirationDateTime: "2099-01-01T00:00:00Z",
  nextExpectedRanges: ["0-"],
}
const location =
  "https://outlook.office.com/api/v2.0/Users('u')/Messages('m')/Attachments('a%2B%2F%3D')"
const file = {
  id: "a",
  "@odata.type": "#microsoft.graph.fileAttachment" as const,
  name: "file.bin",
}
const completed = () => new Response(null, { status: 201, headers: { location } })

test("attachment list/get/download/delete preserve types, bytes and Graph errors", async () => {
  const next = `${GRAPH}users/u/messages/m/attachments?$skiptoken=next`
  const requests = mockFetch((r) => {
    if (r.url.endsWith("/$value")) return new Response(Uint8Array.from([0, 128, 255]))
    if (r.method === "DELETE") return new Response(null, { status: 204 })
    if (r.url.endsWith("/a")) return json(file)
    if (r.url === next) return json({ value: [file] })
    return json({ value: [], "@odata.nextLink": next })
  })
  const { attachments } = (await connect()).mail
  expect(await collect(attachments.listAll("u", "m"))).toEqual([file])
  expect((await attachments.list("u", "m")).value).toEqual([])
  expect(await attachments.get("u", "m", "a")).toEqual(file)
  expect(Array.from(await attachments.download("u", "m", "a"))).toEqual([0, 128, 255])
  await attachments.delete("u", "m", "a")
  expect(requests.every((r) => r.headers.get("prefer") === 'IdType="ImmutableId"')).toBe(true)
  mockFetch(() => apiError(405, "ErrorInvalidRequest"))
  await expect(attachments.downloadResponse("u", "m", "reference")).rejects.toMatchObject({
    status: 405,
  })
})

test("small, empty and inline files use base64 Graph attachments without a session", async () => {
  const requests = mockFetch(() => json(file, 201))
  const { attachments } = (await connect()).mail
  expect(
    await attachments.upload("u", "m", "image.png", Uint8Array.from([0, 128, 255]), {
      isInline: true,
      contentId: "image",
      contentType: "image/png",
    })
  ).toEqual({ id: "a" })
  expect(JSON.parse(String(requests[0].init.body))).toEqual({
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: "image.png",
    contentType: "image/png",
    isInline: true,
    contentId: "image",
    contentBytes: "AID/",
  })
  await attachments.upload("u", "m", "empty", new Blob([]))
  expect(JSON.parse(String(requests[1].init.body)).contentBytes).toBe("")
  expect(requests[0].headers.get("authorization")).toBe("Bearer graph-token")
})

// Countercheck: use Drive's 202 acknowledgement branch or parse the 201 body as JSON; this fails.
test("large files use Outlook 200 acknowledgements, both offset formats, and 201 Location completion", async () => {
  const bytes = new Uint8Array(2 * SIZE + 7)
  bytes[0] = 17
  bytes[SIZE] = 29
  bytes[2 * SIZE] = 41
  let puts = 0
  const requests = mockFetch(async (r) => {
    if (r.method === "POST") return json(session, 201)
    expect(r.headers.has("authorization")).toBe(false)
    expect(r.init.redirect).toBe("manual")
    expect(r.init.credentials).toBe("omit")
    const body = new Uint8Array(await new Response(r.init.body).arrayBuffer())
    expect(body[0]).toBe([17, 29, 41][puts])
    expect(r.headers.get("content-range")).toBe(
      `bytes ${puts * SIZE}-${Math.min((puts + 1) * SIZE, bytes.length) - 1}/${bytes.length}`
    )
    expect(Number(r.headers.get("content-length"))).toBe(body.length)
    puts++
    return puts === 3
      ? completed()
      : json({
          ExpirationDateTime: session.expirationDateTime,
          nextExpectedRanges: [puts === 1 ? String(SIZE) : `${2 * SIZE}-`],
        })
  })
  const { attachments } = (await connect()).mail
  expect(await attachments.upload("u", "m", "large.bin", bytes)).toEqual({ id: "a+/=" })
  expect(JSON.parse(String(requests[0].init.body))).toEqual({
    AttachmentItem: { attachmentType: "file", name: "large.bin", size: bytes.length },
  })
  expect(requests).toHaveLength(4)
})

test("resume uses acknowledged state and retains it if the next request fails", async () => {
  let puts = 0
  const requests = mockFetch(() =>
    ++puts === 1
      ? json({ expirationDateTime: session.expirationDateTime, nextExpectedRanges: [String(SIZE)] })
      : apiError(429, "TooManyRequests", { "retry-after": "30" })
  )
  const { attachments } = (await connect()).mail
  const error = await attachments.resume(session, new Uint8Array(SIZE + 7)).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(MicrosoftMailUploadError)
  expect(error).toMatchObject({
    session: { ...session, nextExpectedRanges: [String(SIZE)] },
    completionUnknown: false,
    cause: { status: 429 },
  })
  expect(requests).toHaveLength(2)
  const resumed = mockFetch(() => completed())
  if (!(error instanceof MicrosoftMailUploadError)) throw new Error("Expected upload error")
  expect(await attachments.resume(error.session, new Uint8Array(SIZE + 7))).toEqual({ id: "a+/=" })
  expect(resumed[0].headers.get("content-range")).toBe(`bytes ${SIZE}-${SIZE + 6}/${SIZE + 7}`)
})

test("a lost final response retains uncertainty and never creates another session", async () => {
  const requests = mockFetch(() => {
    throw new TypeError("lost final response")
  })
  const { attachments } = (await connect({ retry: { maxRetries: 3, shouldRetry: () => true } }))
    .mail
  await expect(
    attachments.resume({ ...session, nextExpectedRanges: [String(SIZE)] }, new Uint8Array(SIZE + 7))
  ).rejects.toMatchObject({ name: "MicrosoftMailUploadError", completionUnknown: true })
  expect(requests).toHaveLength(1)
  expect(requests[0].method).toBe("PUT")
})

// Countercheck: remove the acknowledgement progress guard; the bounded mock reaches a third call.
test("non-advancing upload acknowledgements stop immediately", async () => {
  let calls = 0
  const requests = mockFetch(() => (++calls < 3 ? json(session) : apiError(400)))
  const { attachments } = (await connect()).mail
  await expect(attachments.resume(session, new Uint8Array(SIZE + 7))).rejects.toMatchObject({
    cause: {
      name: "MicrosoftProtocolError",
      message: "[SixbMicrosoft] Outlook attachment acknowledgement did not advance.",
    },
  })
  expect(requests).toHaveLength(1)
})

test("malformed/hostile sessions, invalid offsets and impossible file sizes fail", async () => {
  const requests = mockFetch(() => json({ uploadUrl: session.uploadUrl }))
  const { attachments } = (await connect()).mail
  await expect(attachments.createSession("u", "m", "file", SIZE)).rejects.toBeInstanceOf(
    MicrosoftProtocolError
  )
  for (const value of ["-1", "NaN", "99999999999999999999999", `${SIZE}-0`, ""]) {
    await expect(
      attachments.resume({ ...session, nextExpectedRanges: [value] }, new Uint8Array(SIZE))
    ).rejects.toBeInstanceOf(Error)
  }
  await expect(
    attachments.resume({ ...session, uploadUrl: "http://example.com" }, new Uint8Array(SIZE))
  ).rejects.toBeInstanceOf(MicrosoftProtocolError)
  for (const size of [0, -1, 1, 151 * 1024 * 1024])
    await expect(attachments.createSession("u", "m", "file", size)).rejects.toBeInstanceOf(
      MicrosoftConfigurationError
    )
  await expect(
    attachments.upload("u", "m", "inline", new Blob(["x"]), { isInline: true })
  ).rejects.toBeInstanceOf(MicrosoftConfigurationError)
  expect(requests).toHaveLength(1)
})

test("completion without a valid Location is ambiguous and cannot report success", async () => {
  const { attachments } = (await connect()).mail
  for (const location of [
    undefined,
    "https://outlook.office.com/not-an-attachment",
    "http://outlook.office.com/Attachments('id')",
  ]) {
    mockFetch(() => new Response(null, { status: 201, headers: location ? { location } : {} }))
    await expect(
      attachments.resume(session, new Uint8Array(3 * 1024 * 1024))
    ).rejects.toMatchObject({
      name: "MicrosoftMailUploadError",
      completionUnknown: true,
      cause: { name: "MicrosoftProtocolError" },
    })
  }
})

test("connection cancellation stops subsequent fragments and cancel omits credentials", async () => {
  const controller = new AbortController()
  const requests = mockFetch(() => {
    controller.abort()
    return json({
      expirationDateTime: session.expirationDateTime,
      nextExpectedRanges: [String(SIZE)],
    })
  })
  const { attachments } = (await connect({}, { ...CONTEXT, signal: controller.signal })).mail
  await expect(attachments.resume(session, new Uint8Array(SIZE + 7))).rejects.toMatchObject({
    cause: { name: "AbortError" },
  })
  expect(requests).toHaveLength(1)
  const cancel = mockFetch(() => new Response(null, { status: 204 }))
  await (await connect()).mail.attachments.cancel(session)
  expect(cancel[0].headers.has("authorization")).toBe(false)
  expect(cancel[0].method).toBe("DELETE")
})
