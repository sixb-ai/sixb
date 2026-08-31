import { describe, expect, test } from "bun:test"
import type { SixbHostView } from "@sixb/core"
import { OBJECT_QUERY_STRUCTURE_LIMITS } from "@sixb/core/internal/query"
import { Elysia } from "elysia"
import { registerObjectRoutes } from "../src/routes/objects"
import {
  OBJECT_QUERY_REQUEST_BODY_LIMIT_BYTES,
  parseBoundedObjectQueryBody,
} from "../src/utils/object-query-request-admission"

const queryPaths = [
  "/api/objects/query",
  "/api/objects/query/links",
  "/api/objects/query/count",
  "/api/objects/query/exists",
  "/api/objects/query/facets",
] as const

describe("object query request admission", () => {
  test("rejects recursive query structure on all five query routes before Zod", async () => {
    const app = createObjectRoutesApp()
    let query: unknown = { kind: "start", objectTypeId: "Thing" }
    for (let depth = 0; depth < OBJECT_QUERY_STRUCTURE_LIMITS.maxDepth + 2; depth += 1) {
      query = { kind: "limit", limit: 1, input: query }
    }

    for (const path of queryPaths) {
      const response = await postJson(app, path, { query })
      expect(response.status, path).toBe(400)
      expect(await response.json(), path).toEqual({
        error: `[SixbServer] Object query exceeds the maximum structural depth of ${OBJECT_QUERY_STRUCTURE_LIMITS.maxDepth}.`,
      })
    }
  })

  test("bounds exact-reference arrays before recursive schema validation", async () => {
    const app = createObjectRoutesApp()
    const response = await postJson(app, "/api/objects/query/links", {
      query: {
        kind: "refs",
        refs: Array.from(
          { length: OBJECT_QUERY_STRUCTURE_LIMITS.maxArrayEntries + 1 },
          (_, index) => ({ objectTypeId: "Thing", primaryId: `thing-${index}` })
        ),
      },
      direction: "outgoing",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: `[SixbServer] Object query exceeds the maximum of ${OBJECT_QUERY_STRUCTURE_LIMITS.maxArrayEntries} array entries.`,
    })
  })

  test("rejects deeply nested predicate JSON before recursive schema validation", async () => {
    const app = createObjectRoutesApp()
    let value: unknown = "leaf"
    for (let depth = 0; depth < OBJECT_QUERY_STRUCTURE_LIMITS.maxJsonValueDepth + 2; depth += 1) {
      value = [value]
    }

    const response = await postJson(app, "/api/objects/query", {
      query: {
        kind: "filter",
        input: { kind: "start", objectTypeId: "Thing" },
        predicate: { op: "eq", propertyId: "value", value },
      },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: `[SixbServer] Object query JSON values exceed the maximum depth of ${OBJECT_QUERY_STRUCTURE_LIMITS.maxJsonValueDepth}.`,
    })
  })

  test("bounds recursive predicate fields even when the discriminator is invalid", async () => {
    const app = createObjectRoutesApp()
    let predicate: unknown = { op: "exists", propertyId: "value", value: true }
    for (let depth = 0; depth < OBJECT_QUERY_STRUCTURE_LIMITS.maxDepth + 2; depth += 1) {
      predicate = { op: "invalid", item: predicate }
    }

    const response = await postJson(app, "/api/objects/query/exists", {
      query: {
        kind: "filter",
        input: { kind: "start", objectTypeId: "Thing" },
        predicate,
      },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: `[SixbServer] Object query exceeds the maximum structural depth of ${OBJECT_QUERY_STRUCTURE_LIMITS.maxDepth}.`,
    })
  })

  test("rejects an oversized body independently of its declared content type", async () => {
    const app = createObjectRoutesApp()
    const body = JSON.stringify({ padding: "x".repeat(OBJECT_QUERY_REQUEST_BODY_LIMIT_BYTES) })
    const response = await postRaw(app, "/api/objects/query/facets", body, "text/plain")

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: `[SixbServer] Object query request body exceeds the ${OBJECT_QUERY_REQUEST_BODY_LIMIT_BYTES}-byte limit.`,
    })
  })

  test("maps malformed JSON to a stable response", async () => {
    const app = createObjectRoutesApp()
    const response = await postRaw(app, "/api/objects/query/count", '{"query":')

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "[SixbServer] Object query request body must contain valid UTF-8 JSON.",
    })
  })

  test("does not give JSON semantics to a text/plain body", async () => {
    const app = createObjectRoutesApp()
    const response = await postRaw(
      app,
      "/api/objects/query",
      JSON.stringify({ query: { kind: "start", objectTypeId: "Thing" } }),
      "text/plain; charset=utf-8"
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "Invalid object query request" })
  })

  test("preserves a refs-based query-links envelope", async () => {
    const envelope = {
      query: {
        kind: "refs",
        refs: [{ objectTypeId: "Thing", primaryId: "thing-1" }],
      },
      direction: "both",
      includeObjects: true,
    }
    const request = new Request("http://localhost/api/objects/query/links", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(envelope),
    })

    expect(await parseBoundedObjectQueryBody({ request })).toEqual(envelope)
  })
})

function createObjectRoutesApp() {
  return registerObjectRoutes(new Elysia(), {} as SixbHostView)
}

function postJson(app: ReturnType<typeof createObjectRoutesApp>, path: string, body: unknown) {
  return postRaw(app, path, JSON.stringify(body))
}

function postRaw(
  app: ReturnType<typeof createObjectRoutesApp>,
  path: string,
  body: string,
  contentType = "application/json"
) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    })
  )
}
