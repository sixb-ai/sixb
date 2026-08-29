import { describe, expect, test } from "bun:test"
import { DelegatedExecutionLimitError } from "@sixb/core"
import { Elysia } from "elysia"
import { handleObjectQueryError } from "../src/routes/objects"
import { BulkTelemetryHistoryBodySchema } from "../src/schemas/telemetry"
import {
  MAX_TELEMETRY_HISTORY_SERIES_PER_HTTP_REQUEST,
  mapReadRequestParseError,
  parseBoundedObjectQueryBody,
  parseBoundedTelemetryHistoryBody,
  READ_REQUEST_BODY_LIMIT_BYTES,
} from "../src/utils/read-request-admission"

describe("read request admission", () => {
  test("maps delegated query execution limits to a client error", () => {
    const set: { status?: number | string } = {}

    expect(
      handleObjectQueryError(new DelegatedExecutionLimitError("materializedObjects", 10), set)
    ).toEqual({
      error: "[Sixb] Delegated execution exceeded its materializedObjects limit (10).",
    })
    expect(set.status).toBe(400)
  })

  test("rejects recursive query structure before Zod can exhaust the stack", async () => {
    const app = createAdmissionApp()
    let query: unknown = { kind: "start", objectTypeId: "Thing" }
    for (let depth = 0; depth < 34; depth += 1) {
      query = { kind: "limit", limit: 1, input: query }
    }

    const response = await postJson(app, "/query", { query })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "[SixbServer] Object query exceeds the maximum structural depth of 32.",
    })
  })

  test("bounds exact-reference arrays before schema validation", async () => {
    const app = createAdmissionApp()
    const response = await postJson(app, "/query", {
      query: {
        kind: "refs",
        refs: Array.from({ length: 4_097 }, (_, index) => ({
          objectTypeId: "Thing",
          primaryId: `thing-${index}`,
        })),
      },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "[SixbServer] Object query exceeds the maximum of 4096 array entries.",
    })
  })

  test("rejects deeply nested predicate JSON before recursive schema validation", async () => {
    const app = createAdmissionApp()
    let value: unknown = "leaf"
    for (let depth = 0; depth < 66; depth += 1) value = [value]

    const response = await postJson(app, "/query", {
      query: {
        kind: "filter",
        input: { kind: "start", objectTypeId: "Thing" },
        predicate: { op: "eq", propertyId: "value", value },
      },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "[SixbServer] Object query JSON values exceed the maximum depth of 64.",
    })
  })

  test("rejects an oversized JSON stream before buffering it completely", async () => {
    const app = createAdmissionApp()
    const body = JSON.stringify({ padding: "x".repeat(READ_REQUEST_BODY_LIMIT_BYTES) })
    const response = await postRaw(app, "/query", body)

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: `[SixbServer] Read request body exceeds the ${READ_REQUEST_BODY_LIMIT_BYTES}-byte limit.`,
    })
  })

  test("bounds raw telemetry series before Elysia validates and clones the route body", async () => {
    const app = createAdmissionApp()
    const series = Array.from(
      { length: MAX_TELEMETRY_HISTORY_SERIES_PER_HTTP_REQUEST + 1 },
      (_, index) => ({
        objectTypeId: "Sensor",
        objectId: `sensor-${index}`,
        propertyId: "temperature",
      })
    )

    const response = await postJson(app, "/telemetry", { series, limitPerSeries: 1 })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: `[SixbServer] Telemetry history supports at most ${MAX_TELEMETRY_HISTORY_SERIES_PER_HTTP_REQUEST} series per HTTP request.`,
    })
  })

  test("maps malformed JSON to a stable parse response", async () => {
    const app = createAdmissionApp()
    const response = await postRaw(app, "/query", '{"query":')

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "[SixbServer] Read request body must contain valid UTF-8 JSON.",
    })
  })
})

function createAdmissionApp() {
  return new Elysia()
    .post("/query", ({ body }) => ({ body }), {
      parse: parseBoundedObjectQueryBody,
      error: mapReadRequestParseError,
    })
    .post("/telemetry", ({ body }) => ({ body }), {
      parse: parseBoundedTelemetryHistoryBody,
      error: mapReadRequestParseError,
      body: BulkTelemetryHistoryBodySchema,
    })
}

function postJson(app: ReturnType<typeof createAdmissionApp>, path: string, body: unknown) {
  return postRaw(app, path, JSON.stringify(body))
}

function postRaw(app: ReturnType<typeof createAdmissionApp>, path: string, body: string) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
  )
}
