import { describe, expect, test } from "bun:test"
import { type ListObjectSummariesPage, listObjectsInfiniteOptions } from "../src/hooks"

function objectPage(count: number, hasMore: boolean): ListObjectSummariesPage {
  return {
    hasMore,
    total: 200,
    objects: Array.from({ length: count }, (_, index) => ({
      id: `Device:${index}`,
      primaryId: `device-${index}`,
      objectTypeId: "Device",
      name: `Device ${index}`,
      class: "Device",
      properties: {},
      telemetry: {},
      actions: {},
      telemetryCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
  }
}

describe("listObjectsInfiniteOptions", () => {
  test("keeps the initial offset when calculating the next page", () => {
    const options = listObjectsInfiniteOptions({
      query: {
        limit: "50",
        offset: "100",
      },
    })

    expect(options.initialPageParam).toBe("100")
    expect(
      options.getNextPageParam?.(objectPage(50, true), [objectPage(50, true)], "100", ["100"])
    ).toBe("150")
  })

  test("stops pagination when the current page has no more results", () => {
    const options = listObjectsInfiniteOptions({
      query: {
        limit: "50",
        offset: "100",
      },
    })

    expect(
      options.getNextPageParam?.(objectPage(20, false), [objectPage(20, false)], "100", ["100"])
    ).toBeUndefined()
  })
})
