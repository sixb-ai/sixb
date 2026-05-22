import { describe, expect, test } from "bun:test"
import { createS4RouteHarness } from "./helpers/fixtures"
import { lines, s4, s4Json } from "./helpers/s4"

describe("object routes", () => {
  test("lists object types and object indexes", async () => {
    const { runtime } = await createS4RouteHarness()

    expect(lines(await s4(runtime, "ls /pario/objects"))).toEqual([
      "Device/",
      "Room/",
      "index.json",
    ])
    expect(lines(await s4(runtime, "ls /pario/objects/Device"))).toEqual(["ac-123/", "index.json"])

    const index = await s4Json<{
      objectTypeId: string
      total: number
      objects: Array<{ primaryId: string }>
    }>(runtime, "cat /pario/objects/Device/index.json")
    expect(index).toMatchObject({
      objectTypeId: "Device",
      total: 1,
      objects: [{ primaryId: "ac-123" }],
    })
  })

  test("reads object records and link records", async () => {
    const { runtime } = await createS4RouteHarness()

    expect(lines(await s4(runtime, "ls /pario/objects/Device/ac-123"))).toEqual([
      "actions/",
      "links.json",
      "object.json",
    ])

    const object = await s4Json<{ primaryId: string; properties: Record<string, unknown> }>(
      runtime,
      "cat /pario/objects/Device/ac-123/object.json"
    )
    expect(object.primaryId).toBe("ac-123")
    expect(object.properties.manufacturer).toBe("Panasonic")

    const links = await s4Json<Array<{ linkId: string; targetTypeId: string; targetId: string }>>(
      runtime,
      "cat /pario/objects/Room/room-1/links.json"
    )
    expect(links).toEqual([
      expect.objectContaining({
        linkId: "devices",
        targetTypeId: "Device",
        targetId: "ac-123",
      }),
    ])

    expect(await s4(runtime, "cat /pario/objects/Missing/missing/object.json")).toBe("null")
  })
})
