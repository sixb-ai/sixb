import { afterEach, expect, test } from "bun:test"
import { QuickBooksApiError, QuickBooksWriteError, quickbooks } from "../src"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const bytes = new Uint8Array([37, 80, 68, 70, 45, 0, 128, 255])
const file = new Blob([bytes], { type: "application/pdf" })
const attachment = {
  Id: "42",
  SyncToken: "0",
  FileName: "bill.pdf",
  ContentType: "application/pdf",
  TempDownloadUri: "https://files.example.test/bill.pdf?signature=private",
  AttachableRef: [{ EntityRef: { type: "Bill", value: "9" }, IncludeOnSend: false }],
}
const report = {
  Header: {
    ReportName: "AgedReceivables",
    Currency: "USD",
    Option: [{ Name: "NoReportData", Value: "false" }],
  },
  Columns: {
    Column: [
      { ColTitle: "Customer", ColType: "Customer" },
      { ColTitle: "Total", ColType: "Money" },
    ],
  },
  Rows: {
    Row: [
      {
        type: "Section",
        Header: { ColData: [{ value: "Customer", id: "9" }] },
        Rows: {
          Row: [
            { type: "Data", ColData: [{ value: "" }, { value: "123.40" }], extra: "preserved" },
          ],
        },
        Summary: { ColData: [{ value: "Total" }, { value: "123.40" }] },
      },
    ],
  },
}

function mock(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((url, init) =>
    Promise.resolve(handler(new URL(String(url)), init ?? {}))) as typeof fetch
}
async function client(signal = new AbortController().signal, retryUnsafe = false) {
  return quickbooks({
    clientId: "id",
    clientSecret: "secret",
    environment: "sandbox",
    minorVersion: 76,
    retry: {
      maxRetries: 2,
      delayMs: () => 0,
      shouldRetry: retryUnsafe ? () => true : undefined,
    },
  }).connect({
    projectId: "test",
    connectorId: "qb",
    connectionId: "connection",
    account: { id: "123", label: "Company" },
    signal,
    tokenSource: {
      async get() {
        return { accessToken: "secret-token", invalidate() {} }
      },
    },
  })
}

test("payment PDF uses the payment route and preserves bytes", async () => {
  const qb = await client()
  mock((url, init) => {
    expect(url.pathname).toBe("/v3/company/123/payment/a%2Fb/pdf")
    expect(url.searchParams.get("minorversion")).toBe("76")
    expect(new Headers(init.headers).get("Accept")).toBe("application/pdf")
    return new Response(bytes, { headers: { "Content-Type": "application/pdf" } })
  })
  expect(await qb.payments.downloadPdf("a/b")).toEqual(bytes)
  expect(() => qb.payments.downloadPdf("..")).toThrow()
})

test("attachment reads validate identity and filtered pagination preserves references", async () => {
  const qb = await client()
  const queries: string[] = []
  mock((url) => {
    if (url.pathname.includes("/attachable/")) return Response.json({ Attachable: attachment })
    const query = url.searchParams.get("query") ?? ""
    queries.push(query)
    return Response.json({
      QueryResponse: query.includes("STARTPOSITION 1 ")
        ? { Attachable: [attachment], startPosition: 1, maxResults: 1 }
        : {},
    })
  })
  expect(await qb.attachments.get("42")).toEqual(attachment)
  await expect(qb.attachments.get("43")).rejects.toThrow("does not match")
  const rows = []
  for await (const row of qb.attachments.listAll({
    entity: { type: "Bill", value: "a'b\\c" },
    maxResults: 1,
  }))
    rows.push(row)
  expect(rows).toEqual([attachment])
  expect(queries).toEqual(
    [1, 2].map(
      (start) =>
        `SELECT * FROM Attachable WHERE AttachableRef.EntityRef.Type = 'Bill' AND AttachableRef.EntityRef.value = 'a\\'b\\\\c' STARTPOSITION ${start} MAXRESULTS 1`
    )
  )
})

// Removal proof: use client.get instead of downloads.get in http.download. This
// test fails on the leaked Authorization header (and unwanted Accept header).
test("attachment downloads resolve fresh URLs without forwarding bearer tokens or minorversion", async () => {
  const qb = await client()
  let reads = 0
  mock((url, init) => {
    const headers = new Headers(init.headers)
    if (url.hostname === "sandbox-quickbooks.api.intuit.com") {
      reads++
      expect(headers.get("Authorization")).toBe("Bearer secret-token")
      return Response.json({ Attachable: attachment })
    }
    expect(url.href).toBe(attachment.TempDownloadUri)
    expect(headers.has("Authorization")).toBe(false)
    expect(headers.has("Accept")).toBe(false)
    expect(init.credentials).toBe("omit")
    expect(init.redirect).toBe("error")
    return new Response(bytes)
  })
  expect(await qb.attachments.download("42")).toEqual(bytes)
  expect(await qb.attachments.download("42")).toEqual(bytes)
  expect(reads).toBe(2)
})

test("attachment downloads reject missing and unsafe URLs before fetching a file", async () => {
  const qb = await client()
  for (const uri of [
    undefined,
    "",
    "http://files.example.test/a",
    "https://user:pass@files.example.test/a",
  ]) {
    let calls = 0
    mock(() => {
      calls++
      return Response.json({ Attachable: { ...attachment, TempDownloadUri: uri } })
    })
    await expect(qb.attachments.download("42")).rejects.toThrow()
    expect(calls).toBe(1)
  }
})

test("attachment download retries transient failures but exposes terminal status", async () => {
  const qb = await client()
  let calls = 0
  mock((url) => {
    if (url.pathname.includes("/attachable/")) return Response.json({ Attachable: attachment })
    calls++
    return calls === 1 ? new Response(null, { status: 503 }) : new Response(bytes)
  })
  expect(await qb.attachments.download("42")).toEqual(bytes)
  expect(calls).toBe(2)
  mock((url) =>
    url.pathname.includes("/attachable/")
      ? Response.json({ Attachable: attachment })
      : new Response(null, { status: 403 })
  )
  await expect(qb.attachments.download("42")).rejects.toMatchObject({ status: 403 })
})

test("attachment upload sends paired multipart metadata and exact binary bytes", async () => {
  const qb = await client()
  mock(async (url, init) => {
    expect(url.pathname).toBe("/v3/company/123/upload")
    expect(url.searchParams.get("minorversion")).toBe("76")
    expect(url.searchParams.get("requestid")).toBe("upload-1")
    expect(init.method).toBe("POST")
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer secret-token")
    // Let fetch generate the multipart boundary; never force JSON Content-Type.
    expect(new Headers(init.headers).has("Content-Type")).toBe(false)
    const form = await new Request(url, init).formData()
    const metadata = form.get("file_metadata_0")
    const content = form.get("file_content_0")
    expect(metadata).toBeInstanceOf(Blob)
    expect(content).toBeInstanceOf(File)
    if (!(metadata instanceof Blob) || !(content instanceof File)) throw new Error("Missing parts")
    expect(JSON.parse(await metadata.text())).toEqual({
      FileName: "bill.pdf",
      ContentType: "application/pdf",
      Note: "Supplier invoice",
      AttachableRef: attachment.AttachableRef,
    })
    expect(content.name).toBe("bill.pdf")
    expect(content.type).toBe("application/pdf")
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes)
    return Response.json({ AttachableResponse: [{ Attachable: attachment }] })
  })
  expect(
    await qb.attachments.upload(
      {
        file,
        FileName: "bill.pdf",
        Note: "Supplier invoice",
        AttachableRef: attachment.AttachableRef,
      },
      { requestId: "upload-1" }
    )
  ).toEqual(attachment)
})

// Removal proof: remove { retryable: false } from http.upload; this test's 503
// case observes three writes instead of one under the custom retry policy.
test("attachment upload does not replay failures and preserves nested faults and recovery IDs", async () => {
  const qb = await client(undefined, true)
  for (const kind of ["503", "401", "network", "malformed", "nested", "invalid-json"] as const) {
    let calls = 0
    mock(() => {
      calls++
      if (kind === "network") throw new Error("Connection lost")
      if (kind === "invalid-json") return new Response("not json")
      if (kind === "malformed") return Response.json({ AttachableResponse: [] })
      if (kind === "nested")
        return Response.json(
          {
            AttachableResponse: [
              {
                Fault: {
                  type: "ValidationFault",
                  Error: [{ code: "6000", Message: "Invalid file" }],
                },
              },
            ],
          },
          { headers: { intuit_tid: "trace" } }
        )
      return new Response(null, { status: Number(kind) })
    })
    try {
      await qb.attachments.upload({ file, FileName: "bill.pdf" }, { requestId: "recover" })
      throw new Error("Expected failure")
    } catch (error) {
      expect(error).toBeInstanceOf(
        ["network", "malformed", "invalid-json"].includes(kind)
          ? QuickBooksWriteError
          : QuickBooksApiError
      )
      expect(error).toMatchObject({ writeRequestId: "recover" })
      if (kind === "nested")
        expect(error).toMatchObject({
          requestId: "trace",
          errors: [{ code: "6000", Message: "Invalid file" }],
        })
    }
    expect(calls).toBe(1)
  }
})

test("invalid attachment inputs never contact QuickBooks", async () => {
  const qb = await client()
  let calls = 0
  mock(() => {
    calls++
    return Response.json({})
  })
  expect(() => qb.attachments.list({ maxResults: 1001 })).toThrow()
  expect(() => qb.attachments.list({ entity: { type: "Bill", value: "" } })).toThrow()
  await expect(qb.attachments.upload({ file, FileName: "" })).rejects.toThrow()
  await expect(qb.attachments.upload({ file: new Blob([bytes]), FileName: "a" })).rejects.toThrow()
  await expect(
    qb.attachments.upload({
      file,
      FileName: "a",
      AttachableRef: [{ EntityRef: { type: "", value: "1" } }],
    })
  ).rejects.toThrow()
  await expect(
    qb.attachments.upload({ file, FileName: "a" }, { requestId: "x".repeat(51) })
  ).rejects.toThrow()
  expect(calls).toBe(0)
})

for (const [method, route, party] of [
  ["agedReceivables", "AgedReceivables", "customer"],
  ["agedReceivableDetail", "AgedReceivableDetail", "customer"],
  ["agedPayables", "AgedPayables", "vendor"],
  ["agedPayableDetail", "AgedPayableDetail", "vendor"],
] as const) {
  test(`${method} preserves report columns, nesting and decimal strings`, async () => {
    const qb = await client()
    mock((url, init) => {
      expect(url.pathname).toBe(`/v3/company/123/reports/${route}`)
      expect(new Headers(init.headers).get("Accept")).toBe("application/json")
      expect(Object.fromEntries(url.searchParams)).toEqual({
        minorversion: "76",
        report_date: "2026-09-23",
        aging_method: "Report_Date",
        aging_period: "30",
        num_periods: "4",
        [party]: "1,2",
      })
      return Response.json(report)
    })
    const result = await qb.reports[method]({
      reportDate: "2026-09-23",
      agingMethod: "Report_Date",
      agingPeriod: 30,
      numPeriods: 4,
      ...(party === "customer" ? { customerIds: ["1", "2"] } : { vendorIds: ["1", "2"] }),
    })
    expect(result).toEqual(report)
  })
}

test("aging reports leave defaults to QuickBooks and accept empty report rows", async () => {
  const qb = await client()
  for (const Rows of [undefined, {}, { Row: [] }]) {
    const empty = { ...report, Rows }
    mock((url) => {
      expect([...url.searchParams.keys()]).toEqual(["minorversion"])
      return Response.json(empty)
    })
    expect(await qb.reports.agedReceivables()).toEqual(JSON.parse(JSON.stringify(empty)))
  }
})

test("aging reports validate inputs and reject malformed response structures", async () => {
  const qb = await client()
  let calls = 0
  mock(() => {
    calls++
    return Response.json(report)
  })
  for (const options of [
    { reportDate: "2026-02-30" },
    { agingPeriod: 0 },
    { numPeriods: 1.5 },
    { customerIds: [] },
    { customerIds: ["1,2"] },
  ])
    await expect(qb.reports.agedReceivables(options)).rejects.toThrow()
  expect(calls).toBe(0)
  // Removal proof: remove validateRows(body.Rows); the malformed Rows cases resolve.
  for (const body of [
    {},
    { ...report, Columns: {} },
    { ...report, Rows: [] },
    { ...report, Rows: { Row: [{ ColData: [{ value: 123 }] }] } },
  ]) {
    mock(() => Response.json(body))
    await expect(qb.reports.agedReceivables()).rejects.toThrow()
  }
  mock(() => Response.json({ Fault: { Error: [{ code: "5020", Message: "Permission denied" }] } }))
  await expect(qb.reports.agedPayables()).rejects.toBeInstanceOf(QuickBooksApiError)
})

test("new read operations respect cancellation", async () => {
  const controller = new AbortController()
  const qb = await client(controller.signal)
  let calls = 0
  mock(() => {
    calls++
    return Response.json({})
  })
  controller.abort()
  await expect(qb.attachments.download("42")).rejects.toThrow()
  await expect(qb.reports.agedPayables()).rejects.toThrow()
  await expect(qb.payments.downloadPdf("42")).rejects.toThrow()
  expect(calls).toBe(0)
})

// Removal proof: widen the download return types to Uint8Array (ArrayBufferLike)
// and run bun run build:types && bun run typecheck:tests. BlobPart rejects that
// type because it could contain a SharedArrayBuffer (TypeScript 5.7+).
test("download results can be passed directly to Blob without a copy or cast", async () => {
  const qb = await client()
  mock((url) =>
    url.pathname.includes("/attachable/")
      ? Response.json({ Attachable: attachment })
      : new Response(bytes, { headers: { "Content-Type": "application/pdf" } })
  )
  const blob = new Blob(
    [
      await qb.invoices.downloadPdf("42"),
      await qb.payments.downloadPdf("42"),
      await qb.attachments.download("42"),
    ],
    { type: "application/pdf" }
  )
  expect(blob.size).toBe(bytes.length * 3)
})
