import { describe, expect, test } from "bun:test"
import { createS4RouteHarness } from "./helpers/fixtures"
import { lines, s4, s4Json } from "./helpers/s4"

describe("ontology routes", () => {
  test("lists ontology files and exposes object type actions", async () => {
    const { runtime } = await createS4RouteHarness()

    expect(lines(await s4(runtime, "ls /pario/ontology"))).toEqual(["index.json"])

    const objectTypes = await s4Json<
      Array<{ id: string; actions: Array<{ id: string; params: Array<{ id: string }> }> }>
    >(runtime, "cat /pario/ontology/index.json")
    expect(objectTypes.map((objectType) => objectType.id)).toEqual(["Room", "Device"])
    expect(objectTypes.find((objectType) => objectType.id === "Room")?.actions).toEqual([])
    expect(objectTypes.find((objectType) => objectType.id === "Device")?.actions).toEqual([
      expect.objectContaining({
        id: "setMode",
        params: [expect.objectContaining({ id: "mode" })],
      }),
    ])
  })
})
