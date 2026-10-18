import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { google } from "../src/google"
import type { GoogleClient } from "../src/index"
import { CONTEXT, json, mockFetch, restoreFetch } from "./helpers"

interface RecordedRequest {
  readonly url: URL
  readonly method: string
  readonly auth: string | null
  readonly body: unknown
}

let requests: RecordedRequest[]

async function connect(options?: { readonly retry?: boolean }): Promise<GoogleClient> {
  return google({
    auth: { token: () => "test-token" },
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
    return json({ spreadsheetId: "sheet-id" })
  })
})

afterEach(restoreFetch)

describe("sheets.spreadsheets write and filtered methods", () => {
  test("routes create, get, getByDataFilter, and structural batchUpdate", async () => {
    const spreadsheets = (await connect()).sheets.spreadsheets

    await spreadsheets.create(
      {
        properties: { title: "Revenue", locale: "fr_FR" },
        sheets: [{ properties: { title: "Sales" } }],
      },
      { fields: "spreadsheetId,spreadsheetUrl" }
    )
    await spreadsheets.get("sheet-id", {
      ranges: ["Sales!A1:D5", "Targets!A1:B2"],
      includeGridData: false,
      fields: "spreadsheetId,properties(title),sheets(properties(sheetId,title,index))",
    })
    await spreadsheets.getByDataFilter(
      "sheet-id",
      { dataFilters: [{ a1Range: "Sales!A1:D20" }], includeGridData: true },
      { fields: "spreadsheetId,sheets(data)" }
    )
    await spreadsheets.batchUpdate("sheet-id", {
      requests: [
        { addSheet: { properties: { title: "Forecast" } } },
        { updateSpreadsheetProperties: { properties: { title: "FY27" }, fields: "title" } },
      ],
      includeSpreadsheetInResponse: true,
    })

    expect(requests).toHaveLength(4)
    expect(requests.map((request) => request.method)).toEqual(["POST", "GET", "POST", "POST"])
    expect(requests[0]?.auth).toBe("Bearer test-token")
    expect(requests[0]?.url.pathname).toBe("/v4/spreadsheets")
    expect(requests[0]?.url.searchParams.get("fields")).toBe("spreadsheetId,spreadsheetUrl")
    expect(requests[0]?.body).toEqual({
      properties: { title: "Revenue", locale: "fr_FR" },
      sheets: [{ properties: { title: "Sales" } }],
    })
    expect(`${requests[1]?.url.origin}${requests[1]?.url.pathname}`).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/sheet-id"
    )
    expect(requests[1]?.url.searchParams.getAll("ranges")).toEqual(["Sales!A1:D5", "Targets!A1:B2"])
    expect(requests[1]?.url.searchParams.get("includeGridData")).toBe("false")
    expect(requests[1]?.url.searchParams.get("fields")).toBe(
      "spreadsheetId,properties(title),sheets(properties(sheetId,title,index))"
    )
    expect(requests[2]?.url.pathname).toBe("/v4/spreadsheets/sheet-id:getByDataFilter")
    expect(requests[2]?.body).toEqual({
      dataFilters: [{ a1Range: "Sales!A1:D20" }],
      includeGridData: true,
    })
    expect(requests[3]?.url.pathname).toBe("/v4/spreadsheets/sheet-id:batchUpdate")
    expect(requests[3]?.body).toEqual({
      requests: [
        { addSheet: { properties: { title: "Forecast" } } },
        { updateSpreadsheetProperties: { properties: { title: "FY27" }, fields: "title" } },
      ],
      includeSpreadsheetInResponse: true,
    })
  })
})

describe("sheets.spreadsheets.values write and filtered methods", () => {
  test("routes every values endpoint", async () => {
    const values = (await connect()).sheets.spreadsheets.values

    await values.get("sheet-id", "'Q3 Report/West'!A1:D25", {
      majorDimension: "ROWS",
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    })
    await values.batchGet("sheet-id", {
      ranges: ["Sales!A1:B2", "Targets!A:D"],
      valueRenderOption: "FORMULA",
    })
    await values.batchGetByDataFilter("sheet-id", {
      dataFilters: [{ gridRange: { sheetId: 0, startRowIndex: 1, endRowIndex: 3 } }],
      valueRenderOption: "UNFORMATTED_VALUE",
    })
    await values.update(
      "sheet-id",
      "Sales!A2:B2",
      { values: [["Widget", 12]] },
      { valueInputOption: "RAW", includeValuesInResponse: true }
    )
    await values.append(
      "sheet-id",
      "Sales!A:B",
      { values: [["Gadget", 8]] },
      { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" }
    )
    await values.clear("sheet-id", "Sales!C2:C20")
    await values.batchUpdate("sheet-id", {
      valueInputOption: "RAW",
      data: [
        { range: "Sales!A1", values: [["Product"]] },
        { range: "Sales!B1", values: [["Quantity"]] },
      ],
    })
    await values.batchUpdateByDataFilter("sheet-id", {
      valueInputOption: "RAW",
      data: [
        {
          dataFilter: { developerMetadataLookup: { metadataKey: "forecast" } },
          values: [[100, null]],
        },
      ],
    })
    await values.batchClear("sheet-id", { ranges: ["Sales!D2:D20", "Sales!F2:F20"] })
    await values.batchClearByDataFilter("sheet-id", {
      dataFilters: [{ a1Range: "Archive!A:Z" }],
    })

    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/v4/spreadsheets/sheet-id/values/'Q3%20Report%2FWest'!A1%3AD25",
      "/v4/spreadsheets/sheet-id/values:batchGet",
      "/v4/spreadsheets/sheet-id/values:batchGetByDataFilter",
      "/v4/spreadsheets/sheet-id/values/Sales!A2%3AB2",
      "/v4/spreadsheets/sheet-id/values/Sales!A%3AB:append",
      "/v4/spreadsheets/sheet-id/values/Sales!C2%3AC20:clear",
      "/v4/spreadsheets/sheet-id/values:batchUpdate",
      "/v4/spreadsheets/sheet-id/values:batchUpdateByDataFilter",
      "/v4/spreadsheets/sheet-id/values:batchClear",
      "/v4/spreadsheets/sheet-id/values:batchClearByDataFilter",
    ])
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "POST",
      "PUT",
      "POST",
      "POST",
      "POST",
      "POST",
      "POST",
      "POST",
    ])
    expect(Object.fromEntries(requests[0]?.url.searchParams ?? [])).toEqual({
      majorDimension: "ROWS",
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    })
    expect(requests[1]?.url.searchParams.getAll("ranges")).toEqual(["Sales!A1:B2", "Targets!A:D"])
    expect(requests[1]?.url.searchParams.get("valueRenderOption")).toBe("FORMULA")
    expect(requests[3]?.url.searchParams.get("valueInputOption")).toBe("RAW")
    expect(requests[3]?.url.searchParams.get("includeValuesInResponse")).toBe("true")
    expect(requests[3]?.body).toEqual({ values: [["Widget", 12]] })
    expect(requests[4]?.url.searchParams.get("insertDataOption")).toBe("INSERT_ROWS")
    expect(requests[5]?.body).toEqual({})
    expect(requests[7]?.body).toEqual({
      valueInputOption: "RAW",
      data: [
        {
          dataFilter: { developerMetadataLookup: { metadataKey: "forecast" } },
          values: [[100, null]],
        },
      ],
    })
  })
})

describe("sheets nested resources", () => {
  test("routes developer metadata get/search and sheets.copyTo", async () => {
    const spreadsheets = (await connect()).sheets.spreadsheets

    await spreadsheets.developerMetadata.get("sheet-id", 42)
    await spreadsheets.developerMetadata.search("sheet-id", {
      dataFilters: [{ developerMetadataLookup: { metadataKey: "region", metadataValue: "emea" } }],
    })
    await spreadsheets.sheets.copyTo("sheet-id", 7, {
      destinationSpreadsheetId: "destination-id",
    })

    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/v4/spreadsheets/sheet-id/developerMetadata/42",
      "/v4/spreadsheets/sheet-id/developerMetadata:search",
      "/v4/spreadsheets/sheet-id/sheets/7:copyTo",
    ])
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST", "POST"])
    expect(requests[1]?.body).toEqual({
      dataFilters: [{ developerMetadataLookup: { metadataKey: "region", metadataValue: "emea" } }],
    })
    expect(requests[2]?.body).toEqual({ destinationSpreadsheetId: "destination-id" })
  })

  test("validates ranges, batch collections, data-filter selectors, and numeric ids locally", async () => {
    const spreadsheets = (await connect()).sheets.spreadsheets

    expect(() => spreadsheets.values.get("sheet-id", "")).toThrow(
      "[SixbGoogle] range must not be empty."
    )
    expect(() => spreadsheets.values.batchGet("sheet-id", { ranges: [] })).toThrow(
      "[SixbGoogle] options.ranges must contain at least one range."
    )
    expect(() =>
      spreadsheets.values.batchGet("sheet-id", { ranges: ["Sales!A1:B2", " "] })
    ).toThrow("[SixbGoogle] options.ranges item must not be empty.")
    expect(() => spreadsheets.batchUpdate("sheet-id", { requests: [] })).toThrow(
      /request.requests must contain at least one operation/
    )
    expect(() => spreadsheets.values.batchGetByDataFilter("sheet-id", { dataFilters: [] })).toThrow(
      /request.dataFilters must contain at least one item/
    )
    expect(() =>
      spreadsheets.values.batchClearByDataFilter("sheet-id", {
        dataFilters: [{ a1Range: "A1", gridRange: { sheetId: 0 } }],
      })
    ).toThrow(/must set exactly one/)
    expect(() => spreadsheets.values.batchClear("sheet-id", { ranges: [] })).toThrow(
      /request.ranges must contain at least one range/
    )
    expect(() => spreadsheets.developerMetadata.get("sheet-id", -1)).toThrow(
      /metadataId must be a non-negative safe integer/
    )
    expect(() =>
      spreadsheets.sheets.copyTo("sheet-id", 1.5, { destinationSpreadsheetId: "target" })
    ).toThrow(/sheetId must be a non-negative safe integer/)
    expect(requests).toHaveLength(0)
  })
})

describe("sheets retry safety", () => {
  test("retries read-only POSTs but never replays mutations", async () => {
    let attempts = 0
    mockFetch(async (input, init) => {
      record(input, init)
      attempts++
      return attempts === 1 ? new Response("busy", { status: 503 }) : json({ spreadsheetId: "x" })
    })
    const spreadsheets = (await connect({ retry: true })).sheets.spreadsheets

    await spreadsheets.getByDataFilter("sheet-id", { dataFilters: [{ a1Range: "A1:B2" }] })
    expect(attempts).toBe(2)

    attempts = 0
    mockFetch(async (input, init) => {
      record(input, init)
      attempts++
      return new Response("busy", { status: 503 })
    })
    await expect(
      spreadsheets.values.update("sheet-id", "A1", { values: [[1]] }, { valueInputOption: "RAW" })
    ).rejects.toThrow(/Google API request failed/)
    expect(attempts).toBe(1)
  })
})
