import { describe, expect, test } from "bun:test"
import { decodeObjectId, encodeObjectId } from "@sixb/client"
import { matchRoutes } from "react-router-dom"
import { objectDetailPath, objectIdFromPathSegment } from "../src/lib/objectRoutes"

describe("object routes", () => {
  test("preserves already encoded primary ids through the router decoding boundary", () => {
    // Regression proof: returning `/${objectId}` from objectDetailPath makes React Router turn the
    // literal `%2F` in this primary id into `/`, so this test fails.
    const primaryId = "site%2Fnorth%2Fdevice%2F100"
    const objectId = encodeObjectId("point", primaryId)
    const path = objectDetailPath(objectId)

    expect(path).toBe("/point~site%25252Fnorth%25252Fdevice%25252F100")

    const routeParam = matchRoutes([{ path: "/:objectId" }], path)?.[0]?.params.objectId
    expect(routeParam).toBe(objectId)
    expect(decodeObjectId(routeParam ?? "")).toEqual({ objectTypeId: "point", primaryId })
    expect(objectIdFromPathSegment(path.slice(1))).toBe(objectId)
  })

  test("preserves reserved and unicode characters in object ids", () => {
    const primaryId = "north/Paris #1?température=20%"
    const objectId = encodeObjectId("sensor/type", primaryId)
    const routeParam = objectIdFromPathSegment(objectDetailPath(objectId).slice(1))

    expect(decodeObjectId(routeParam)).toEqual({ objectTypeId: "sensor/type", primaryId })
  })
})
