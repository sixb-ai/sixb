import { describe, expect, test } from "bun:test"
import { createS4RouteHarness } from "./helpers/fixtures"
import { lines, s4, s4Json } from "./helpers/s4"

describe("sync routes", () => {
  test("lists syncs and reads sync definitions", async () => {
    const { runtime, versionId } = await createS4RouteHarness()

    expect(lines(await s4(runtime, "ls /pario/syncs"))).toEqual(["index.json", "sync-devices/"])
    expect(lines(await s4(runtime, "ls /pario/syncs/sync-devices"))).toEqual([
      "definition.json",
      "runs/",
    ])

    const sync = await s4Json<{
      id: string
      connector: { id: string; type: string }
      target: { dataset: { id: string } }
      latestRun: { id: string; status: string; output?: { versionId: string } } | null
    }>(runtime, "cat /pario/syncs/sync-devices/definition.json")
    expect(sync).toMatchObject({
      id: "sync-devices",
      connector: { id: "devices-api", type: "test" },
      target: { dataset: { id: "raw.devices" } },
      latestRun: {
        id: "run-previous",
        status: "succeeded",
        output: { versionId },
      },
    })
  })

  test("lists sync runs", async () => {
    const { runtime, versionId } = await createS4RouteHarness()

    expect(lines(await s4(runtime, "ls /pario/syncs/sync-devices/runs"))).toEqual(["index.json"])
    const runs = await s4Json<{
      total: number
      hasMore: boolean
      runs: Array<{ id: string; syncId: string; status: string; output?: { versionId: string } }>
    }>(runtime, "cat /pario/syncs/sync-devices/runs/index.json")
    expect(runs).toMatchObject({
      total: 1,
      hasMore: false,
      runs: [
        {
          id: "run-previous",
          syncId: "sync-devices",
          status: "succeeded",
          output: { versionId },
        },
      ],
    })
  })
})
