import { afterEach, expect, test } from "bun:test"
import type { ConnectorTokenSource } from "@sixb/core"
import { QuickBooksApiError, quickbooks } from "../src"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

// Include non-UTF-8 bytes: decoding the PDF as text must not silently corrupt it.
const pdf = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 128, 255])
function pdfResponse() {
  return new Response(pdf, { headers: { "Content-Type": "application/pdf; charset=binary" } })
}
function mock(handler: (url: URL, init: RequestInit) => Response) {
  globalThis.fetch = ((url, init) =>
    Promise.resolve(handler(new URL(String(url)), init ?? {}))) as typeof fetch
}
async function client(
  environment: "sandbox" | "production" = "sandbox",
  tokens?: ConnectorTokenSource,
  signal = new AbortController().signal
) {
  return quickbooks({
    clientId: "id",
    clientSecret: "secret",
    environment,
    minorVersion: 76,
    retry: { maxRetries: 1, delayMs: () => 0 },
  }).connect({
    projectId: "test",
    connectorId: "qb",
    connectionId: "connection",
    account: { id: "123", label: "Company" },
    signal,
    tokenSource: tokens ?? {
      async get() {
        return { accessToken: "token", invalidate() {} }
      },
    },
  })
}

// Removal proof: replace getPdf's final byte conversion with parseResponse(response).
// The binary success test fails because the JSON reader cannot consume a PDF.
test("invoice PDF preserves bytes, scopes and encodes the URL, and overrides only PDF Accept", async () => {
  for (const environment of ["sandbox", "production"] as const) {
    const qb = await client(environment)
    mock((url, init) => {
      expect(url.hostname).toBe(
        environment === "sandbox"
          ? "sandbox-quickbooks.api.intuit.com"
          : "quickbooks.api.intuit.com"
      )
      expect(init.method).toBe("GET")
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token")
      expect(url.searchParams.get("minorversion")).toBe("76")
      if (url.pathname.endsWith("/pdf")) {
        expect(url.pathname).toBe("/v3/company/123/invoice/a%2Fb%3F%23/pdf")
        expect(new Headers(init.headers).get("Accept")).toBe("application/pdf")
        return pdfResponse()
      }
      expect(new Headers(init.headers).get("Accept")).toBe("application/json")
      return Response.json({ Invoice: { Id: "42" } })
    })
    expect(await qb.invoices.downloadPdf("a/b?#")).toEqual(pdf)
    expect((await qb.invoices.get("42")).Id).toBe("42")
  }
})

test("invoice PDF rejects invalid IDs before fetching", async () => {
  const qb = await client()
  let calls = 0
  mock(() => {
    calls++
    return pdfResponse()
  })
  for (const id of ["", " ", ".", ".."]) {
    expect(() => qb.invoices.downloadPdf(id)).toThrow("[SixbQuickBooks]")
  }
  expect(calls).toBe(0)
})

test("invoice PDF retains provider fault details even on HTTP 200", async () => {
  const qb = await client()
  const errors = [{ code: "610", Message: "Object Not Found", Detail: "Missing invoice" }]
  for (const status of [400, 200]) {
    mock(() =>
      Response.json(
        { Fault: { type: "ValidationFault", Error: errors } },
        {
          status,
          headers: { intuit_tid: "trace-id" },
        }
      )
    )
    try {
      await qb.invoices.downloadPdf("42")
      throw new Error("Expected download to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(QuickBooksApiError)
      expect(error).toMatchObject({
        status,
        requestId: "trace-id",
        faultType: "ValidationFault",
        errors,
      })
    }
  }
})

test("invoice PDF rejects successful non-PDF bodies and non-JSON errors", async () => {
  const qb = await client()
  for (const response of [
    Response.json({ Invoice: { Id: "42" } }),
    new Response("<html>Error</html>", { headers: { "Content-Type": "text/html" } }),
    new Response("Forbidden", { status: 403 }),
  ]) {
    mock(() => response)
    await expect(qb.invoices.downloadPdf("42")).rejects.toThrow("[SixbQuickBooks]")
  }
})

test("invoice PDF refreshes a rejected token and retries throttling through REST", async () => {
  let invalidations = 0
  const qb = await client("sandbox", {
    async get() {
      return {
        accessToken: invalidations ? "fresh" : "old",
        invalidate() {
          invalidations++
        },
      }
    },
  })
  let calls = 0
  mock((_url, init) => {
    calls++
    expect(new Headers(init.headers).get("Accept")).toBe("application/pdf")
    expect(new Headers(init.headers).get("Authorization")).toBe(
      `Bearer ${calls === 1 ? "old" : "fresh"}`
    )
    if (calls === 1) return new Response(null, { status: 401 })
    if (calls === 2) return new Response(null, { status: 429, headers: { "Retry-After": "0" } })
    return pdfResponse()
  })
  expect(await qb.invoices.downloadPdf("42")).toEqual(pdf)
  expect(invalidations).toBe(1)
  expect(calls).toBe(3)
})

test("invoice PDF respects connection cancellation", async () => {
  const controller = new AbortController()
  const qb = await client("sandbox", undefined, controller.signal)
  let calls = 0
  mock(() => {
    calls++
    return pdfResponse()
  })
  controller.abort()
  await expect(qb.invoices.downloadPdf("42")).rejects.toThrow()
  expect(calls).toBe(0)
})
