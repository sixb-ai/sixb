import { afterEach, describe, expect, test } from "bun:test"
import { google } from "../src/google"
import type { GoogleClient } from "../src/index"
import { CONTEXT, json, mockFetch, restoreFetch } from "./helpers"

async function connect(): Promise<GoogleClient> {
  return google({ auth: { token: () => "test-token" } }).connect(CONTEXT)
}

afterEach(restoreFetch)

describe("sheets.spreadsheets", () => {
  test("get reads spreadsheet metadata with repeated ranges", async () => {
    let request: { url: URL; auth: string | null } | undefined
    mockFetch(async (input, init) => {
      request = {
        url: new URL(input.toString()),
        auth: new Headers(init?.headers).get("authorization"),
      }
      return json({
        spreadsheetId: "sheet-id",
        properties: { title: "Revenue", timeZone: "America/New_York" },
        sheets: [{ properties: { sheetId: 0, title: "Sales" } }],
      })
    })

    const client = await connect()
    const spreadsheet = await client.sheets.spreadsheets.get("sheet-id", {
      ranges: ["Sales!A1:D5", "Targets!A1:B2"],
      includeGridData: false,
      fields: "spreadsheetId,properties(title),sheets(properties(sheetId,title,index))",
    })

    expect(spreadsheet.properties?.title).toBe("Revenue")
    expect(spreadsheet.sheets?.[0]?.properties?.title).toBe("Sales")
    expect(request?.url.origin).toBe("https://sheets.googleapis.com")
    expect(request?.url.pathname).toBe("/v4/spreadsheets/sheet-id")
    expect(request?.url.searchParams.getAll("ranges")).toEqual(["Sales!A1:D5", "Targets!A1:B2"])
    expect(request?.url.searchParams.get("includeGridData")).toBe("false")
    expect(request?.url.searchParams.get("fields")).toBe(
      "spreadsheetId,properties(title),sheets(properties(sheetId,title,index))"
    )
    expect(request?.auth).toBe("Bearer test-token")
  })

  test("get rejects an empty spreadsheet id before issuing a request", async () => {
    let calls = 0
    mockFetch(async () => {
      calls++
      return json({})
    })

    const client = await connect()
    expect(() => client.sheets.spreadsheets.get("  ")).toThrow(
      "[SixbGoogle] spreadsheetId must not be empty."
    )
    expect(calls).toBe(0)
  })
})

describe("sheets.spreadsheets.values", () => {
  test("get reads a range with explicit rendering options", async () => {
    let requestUrl: URL | undefined
    mockFetch(async (input) => {
      requestUrl = new URL(input.toString())
      return json({
        range: "'Q3 Report/West'!A1:D25",
        majorDimension: "ROWS",
        values: [
          ["date", "revenue"],
          ["2026-08-25", 1250.5],
          ["active", true],
        ],
      })
    })

    const client = await connect()
    const result = await client.sheets.spreadsheets.values.get(
      "sheet-id",
      "'Q3 Report/West'!A1:D25",
      {
        majorDimension: "ROWS",
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "FORMATTED_STRING",
      }
    )

    expect(result.values?.[1]?.[1]).toBe(1250.5)
    expect(requestUrl?.pathname).toContain("%2F")
    expect(decodeURIComponent(requestUrl?.pathname ?? "")).toBe(
      "/v4/spreadsheets/sheet-id/values/'Q3 Report/West'!A1:D25"
    )
    expect(requestUrl?.searchParams.get("majorDimension")).toBe("ROWS")
    expect(requestUrl?.searchParams.get("valueRenderOption")).toBe("UNFORMATTED_VALUE")
    expect(requestUrl?.searchParams.get("dateTimeRenderOption")).toBe("FORMATTED_STRING")
  })

  test("batchGet encodes ranges as repeated query parameters", async () => {
    let requestUrl: URL | undefined
    mockFetch(async (input) => {
      requestUrl = new URL(input.toString())
      return json({
        spreadsheetId: "sheet-id",
        valueRanges: [{ range: "Sales!A1:B2", values: [["a", "b"]] }],
      })
    })

    const client = await connect()
    const result = await client.sheets.spreadsheets.values.batchGet("sheet-id", {
      ranges: ["Sales!A1:B2", "Targets!A:D"],
      valueRenderOption: "FORMULA",
    })

    expect(result.spreadsheetId).toBe("sheet-id")
    expect(requestUrl?.pathname).toBe("/v4/spreadsheets/sheet-id/values:batchGet")
    expect(requestUrl?.searchParams.getAll("ranges")).toEqual(["Sales!A1:B2", "Targets!A:D"])
    expect(requestUrl?.searchParams.get("valueRenderOption")).toBe("FORMULA")
  })

  test("get and batchGet reject empty ranges before issuing a request", async () => {
    let calls = 0
    mockFetch(async () => {
      calls++
      return json({})
    })

    const client = await connect()
    expect(() => client.sheets.spreadsheets.values.get("sheet-id", "")).toThrow(
      "[SixbGoogle] range must not be empty."
    )
    expect(() => client.sheets.spreadsheets.values.batchGet("sheet-id", { ranges: [] })).toThrow(
      "[SixbGoogle] options.ranges must contain at least one range."
    )
    expect(() =>
      client.sheets.spreadsheets.values.batchGet("sheet-id", {
        ranges: ["Sales!A1:B2", " "],
      })
    ).toThrow("[SixbGoogle] options.ranges item must not be empty.")
    expect(calls).toBe(0)
  })
})
