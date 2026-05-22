import { describe, expect, test } from "bun:test"
import { createS4RouteHarness } from "./helpers/fixtures"
import { lines, s4, s4Json } from "./helpers/s4"

describe("dataset routes", () => {
  test("lists datasets and reads dataset schema metadata", async () => {
    const { runtime, versionId } = await createS4RouteHarness()

    expect(lines(await s4(runtime, "ls /pario/datasets"))).toEqual(["index.json", "raw.devices/"])
    expect(lines(await s4(runtime, "ls /pario/datasets/raw.devices"))).toEqual([
      "schema.json",
      "versions/",
    ])

    const dataset = await s4Json<{
      id: string
      materialized: boolean
      latestVersion: { versionId: string } | null
    }>(runtime, "cat /pario/datasets/raw.devices/schema.json")
    expect(dataset).toMatchObject({
      id: "raw.devices",
      materialized: true,
      latestVersion: { versionId },
    })
  })

  test("lists and reads dataset versions", async () => {
    const { runtime, versionId } = await createS4RouteHarness()
    const versionPath = encodeURIComponent(versionId)

    expect(lines(await s4(runtime, "ls /pario/datasets/raw.devices/versions"))).toEqual([
      "index.json",
      `${versionPath}/`,
    ])

    const versions = await s4Json<{
      count: number
      versions: Array<{ datasetId: string; versionId: string; rowCount?: number }>
    }>(runtime, "cat /pario/datasets/raw.devices/versions/index.json")
    expect(versions).toMatchObject({
      count: 1,
      versions: [expect.objectContaining({ datasetId: "raw.devices", versionId, rowCount: 1 })],
    })

    expect(
      lines(await s4(runtime, `ls /pario/datasets/raw.devices/versions/${versionPath}`))
    ).toEqual(["version.json"])
    const version = await s4Json<{ datasetId: string; versionId: string; rowCount?: number }>(
      runtime,
      `cat /pario/datasets/raw.devices/versions/${versionPath}/version.json`
    )
    expect(version).toMatchObject({ datasetId: "raw.devices", versionId, rowCount: 1 })
  })
})
