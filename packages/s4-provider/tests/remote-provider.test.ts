import { describe, expect, test } from "bun:test"
import { PAGE_SIZE } from "../src/constants"
import { createS4RouteHarness } from "./helpers/fixtures"
import { s4Json } from "./helpers/s4"

describe("remote provider HTTP shape", () => {
  test("maps S4 calls onto the Pario HTTP API", async () => {
    const { runtime, requests } = await createS4RouteHarness()

    await runtime.run("cat /pario/ontology/index.json")
    await runtime.run("ls /pario/objects/Device")
    const invokeResult = await s4Json<{ status: string; value: { runId: string } }>(
      runtime,
      'invoke /pario/objects/Device/ac-123/actions/setMode --input \'{"mode":"cool"}\''
    )
    expect(invokeResult.status).toBe("accepted")

    const objectTypesRequest = requests.find((entry) => entry.url.pathname === "/api/object-types")
    expect(objectTypesRequest?.request.method).toBe("GET")

    const listObjectsRequest = requests.find((entry) => entry.url.pathname === "/api/objects")
    expect(listObjectsRequest?.url.searchParams.get("objectTypeId")).toBe("Device")
    expect(listObjectsRequest?.url.searchParams.get("limit")).toBe(String(PAGE_SIZE))
    expect(listObjectsRequest?.url.searchParams.get("offset")).toBe("0")
    expect(listObjectsRequest?.url.searchParams.get("orderBy")).toBe("primaryId")
    expect(listObjectsRequest?.url.searchParams.get("order")).toBe("asc")

    const actionRequest = requests.find(
      (entry) => entry.url.pathname === "/api/objects/Device/ac-123/actions/setMode"
    )
    expect(actionRequest?.request.method).toBe("POST")
    expect(actionRequest?.body).toBe(JSON.stringify({ params: { mode: "cool" } }))
  })
})
