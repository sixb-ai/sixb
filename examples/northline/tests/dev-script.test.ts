import { describe, expect, test } from "bun:test"
import { createRuntimeCommand, probeNorthlineApi, resolveDevPorts } from "../scripts/dev"

describe("Northline development script", () => {
  test("forwards its arguments to the Sixb dev command", () => {
    const command = createRuntimeCommand([
      "--port",
      "4100",
      "--api-port=4102",
      "--host",
      "127.0.0.1",
    ])

    expect(command.slice(2)).toEqual([
      "dev",
      "--port",
      "4100",
      "--api-port=4102",
      "--host",
      "127.0.0.1",
    ])
  })

  test("waits for the API on the ports Sixb dev was given", () => {
    expect(resolveDevPorts([])).toEqual({ appPort: 3000, apiPort: 3001 })
    expect(resolveDevPorts(["--port", "4100"])).toEqual({ appPort: 4100, apiPort: 4101 })
    expect(resolveDevPorts(["--port=4100", "--api-port", "4200"])).toEqual({
      appPort: 4100,
      apiPort: 4200,
    })
    expect(() => resolveDevPorts(["--port", "web"])).toThrow("--port must be a port number")
  })

  test("accepts readiness only from the Northline project", async () => {
    const requests: string[] = []
    const probe = await probeNorthlineApi("http://localhost:3001/api", async (url) => {
      requests.push(url)
      return Response.json({ id: "northline" })
    })

    expect(requests).toEqual(["http://localhost:3001/api/project"])
    expect(probe).toEqual({ status: "ready" })
  })

  test("identifies a different Sixb project on the API port", async () => {
    const probe = await probeNorthlineApi("http://localhost:3001/api", async () =>
      Response.json({ id: "apic" })
    )

    expect(probe).toEqual({ status: "wrong-project", projectId: "apic" })
  })

  test("keeps waiting for an unavailable or malformed API", async () => {
    const unavailable = await probeNorthlineApi("http://localhost:3001/api", async () =>
      Response.json({ error: "starting" }, { status: 503 })
    )
    const malformed = await probeNorthlineApi("http://localhost:3001/api", async () =>
      Response.json({ status: "ok" })
    )

    expect(unavailable).toEqual({ status: "unavailable" })
    expect(malformed).toEqual({ status: "unavailable" })
  })
})
