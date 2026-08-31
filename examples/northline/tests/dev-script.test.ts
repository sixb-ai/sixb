import { describe, expect, test } from "bun:test"
import { createRuntimeCommand, probeNorthlineApi } from "../scripts/dev"

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

  test("accepts readiness only from the Northline project", async () => {
    const requests: string[] = []
    const probe = await probeNorthlineApi("http://localhost:3002/api", async (url) => {
      requests.push(url)
      return Response.json({ id: "northline" })
    })

    expect(requests).toEqual(["http://localhost:3002/api/project"])
    expect(probe).toEqual({ status: "ready" })
  })

  test("identifies a different Sixb project on the API port", async () => {
    const probe = await probeNorthlineApi("http://localhost:3002/api", async () =>
      Response.json({ id: "apic" })
    )

    expect(probe).toEqual({ status: "wrong-project", projectId: "apic" })
  })

  test("keeps waiting for an unavailable or malformed API", async () => {
    const unavailable = await probeNorthlineApi("http://localhost:3002/api", async () =>
      Response.json({ error: "starting" }, { status: 503 })
    )
    const malformed = await probeNorthlineApi("http://localhost:3002/api", async () =>
      Response.json({ status: "ok" })
    )

    expect(unavailable).toEqual({ status: "unavailable" })
    expect(malformed).toEqual({ status: "unavailable" })
  })
})
