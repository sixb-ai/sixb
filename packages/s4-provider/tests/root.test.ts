import { describe, expect, test } from "bun:test"
import { createS4RouteHarness } from "./helpers/fixtures"
import { lines, s4, s4Json } from "./helpers/s4"

describe("root routes", () => {
  test("lists the mounted Pario tree and reads status", async () => {
    const { runtime } = await createS4RouteHarness()

    expect(lines(await s4(runtime, "ls /pario"))).toEqual([
      "datasets/",
      "objects/",
      "ontology/",
      "status.json",
      "syncs/",
    ])

    const status = await s4Json<{ status: string; objectTypes: number }>(
      runtime,
      "cat /pario/status.json"
    )
    expect(status.status).toBe("ok")
    expect(status.objectTypes).toBe(2)
  })
})
