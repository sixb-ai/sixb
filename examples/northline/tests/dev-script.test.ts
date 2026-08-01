import { describe, expect, test } from "bun:test"
import { createRuntimeCommand } from "../scripts/dev"

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
})
